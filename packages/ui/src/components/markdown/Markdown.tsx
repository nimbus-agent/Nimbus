import { marked, type Token, type Tokens } from "marked";
import type { ReactNode } from "react";

/**
 * Renders untrusted markdown as React elements built here, from `marked`'s lexer only. Nothing
 * calls an HTML-producing API, and nothing here emits an anchor, an image, a style attribute or
 * `dangerouslySetInnerHTML`: raw HTML and unrecognised tokens show as their literal source text, a
 * link shows its URL as plain text, and an image shows its alt text and loads nothing.
 */

const MARKED_OPTIONS = { gfm: true } as const;
const HEADING_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

function raw(t: Token): string {
  return typeof t.raw === "string" ? t.raw : "";
}

function inline(tokens: readonly Token[] | undefined, key: string): ReactNode[] {
  return (tokens ?? []).map((t, i) => inlineToken(t, `${key}.${i}`));
}

function textOf(tokens: readonly Token[] | undefined): string {
  return (tokens ?? [])
    .map((t) => ("text" in t && typeof t.text === "string" ? t.text : raw(t)))
    .join("");
}

function inlineToken(t: Token, key: string): ReactNode {
  switch (t.type) {
    case "text": {
      const x = t as Tokens.Text;
      return x.tokens !== undefined && x.tokens.length > 0 ? (
        <span key={key}>{inline(x.tokens, key)}</span>
      ) : (
        x.text
      );
    }
    case "strong":
      return <strong key={key}>{inline((t as Tokens.Strong).tokens, key)}</strong>;
    case "em":
      return <em key={key}>{inline((t as Tokens.Em).tokens, key)}</em>;
    case "del":
      return <del key={key}>{inline((t as Tokens.Del).tokens, key)}</del>;
    case "codespan":
      return (
        <code key={key} className="font-mono text-xs">
          {(t as Tokens.Codespan).text}
        </code>
      );
    case "br":
      return <br key={key} />;
    case "link": {
      const l = t as Tokens.Link;
      const label = l.tokens.length > 0 ? inline(l.tokens, key) : l.text;
      const showUrl = l.href !== textOf(l.tokens) && l.href !== l.text;
      return (
        <span key={key}>
          <span>{label}</span>
          {showUrl ? (
            <>
              {" ("}
              <span className="select-text font-mono">{l.href}</span>
              {")"}
            </>
          ) : null}
        </span>
      );
    }
    case "image":
      return <span key={key}>{(t as Tokens.Image).text}</span>;
    default:
      // html, escape and anything unrecognised: the literal source, as text.
      return raw(t);
  }
}

function listItem(item: Tokens.ListItem, key: string): ReactNode {
  return (
    <li key={key}>
      {item.task ? (item.checked ? "[x] " : "[ ] ") : null}
      {blocks(item.tokens, key)}
    </li>
  );
}

function table(t: Tokens.Table, key: string): ReactNode {
  return (
    <table key={key} className="text-xs border-collapse">
      <thead>
        <tr>
          {t.header.map((h, i) => (
            <th
              // biome-ignore lint/suspicious/noArrayIndexKey: static cells of one lexed table
              key={i}
              className="border border-[var(--color-border)] px-2 py-1 text-left"
            >
              {inline(h.tokens, `${key}.h${i}`)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {t.rows.map((row, r) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static rows of one lexed table
          <tr key={r}>
            {row.map((c, i) => (
              <td
                // biome-ignore lint/suspicious/noArrayIndexKey: static cells of one lexed table
                key={i}
                className="border border-[var(--color-border)] px-2 py-1"
              >
                {inline(c.tokens, `${key}.r${r}c${i}`)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function block(t: Token, key: string): ReactNode {
  switch (t.type) {
    case "space":
      return null;
    case "heading": {
      const h = t as Tokens.Heading;
      const Tag = HEADING_TAGS[Math.min(Math.max(h.depth, 1), 6) - 1] ?? "h6";
      return (
        <Tag key={key} className="font-semibold text-sm">
          {inline(h.tokens, key)}
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p key={key} className="text-sm">
          {inline((t as Tokens.Paragraph).tokens, key)}
        </p>
      );
    case "text": {
      const x = t as Tokens.Text;
      return <span key={key}>{x.tokens ? inline(x.tokens, key) : x.text}</span>;
    }
    case "code":
      return (
        <pre
          key={key}
          className="whitespace-pre-wrap break-words font-mono text-xs border border-[var(--color-border)] rounded-md p-2"
        >
          <code>{(t as Tokens.Code).text}</code>
        </pre>
      );
    case "blockquote":
      return (
        <blockquote key={key} className="border-l-2 border-[var(--color-border)] pl-3 text-sm">
          {blocks((t as Tokens.Blockquote).tokens, key)}
        </blockquote>
      );
    case "hr":
      return <hr key={key} className="border-[var(--color-border)]" />;
    case "list": {
      const l = t as Tokens.List;
      const items = l.items.map((it, i) => listItem(it, `${key}.${i}`));
      return l.ordered ? (
        <ol key={key} className="list-decimal pl-5 text-sm">
          {items}
        </ol>
      ) : (
        <ul key={key} className="list-disc pl-5 text-sm">
          {items}
        </ul>
      );
    }
    case "table":
      return table(t as Tokens.Table, key);
    case "def":
      return null;
    default:
      // html and anything unrecognised: the literal source, as text.
      return (
        <p key={key} className="text-sm whitespace-pre-wrap break-words">
          {raw(t)}
        </p>
      );
  }
}

function blocks(tokens: readonly Token[] | undefined, key: string): ReactNode[] {
  return (tokens ?? []).map((t, i) => block(t, `${key}.${i}`));
}

export function Markdown({ text }: { readonly text: string }): ReactNode {
  return (
    <div className="space-y-2 break-words">{blocks(marked.lexer(text, MARKED_OPTIONS), "m")}</div>
  );
}
