import { Fragment, type ReactNode } from "react";

/**
 * A page's text, rendered.
 *
 * **Nothing here ever produces HTML from the record.** No
 * `dangerouslySetInnerHTML`, no HTML pass-through, no sanitiser to get subtly
 * wrong — the body is somebody's writing, and on a knowledge base that anyone
 * with `edit` can change, injecting it as markup is a stored XSS with the
 * record as the vector. Every construct below is turned into React elements,
 * so unrecognised markup is TEXT and stays text.
 *
 * The subset is deliberately small and matches what Canon's pages actually
 * use: headings, paragraphs, lists, block quotes, fenced and inline code,
 * bold, italic and links. Anything else renders as the characters somebody
 * typed, which is the honest failure — a page that shows its own asterisks is
 * legible; a page that swallows a line is not.
 *
 * Links are the one place a URL from the record reaches an attribute, so the
 * scheme is checked: `http`, `https`, `mailto` and in-app fragments only.
 * `javascript:` is rendered as plain text rather than quietly dropped, so the
 * author can see what they wrote.
 */
export function Markdown({ body }: { body: string }) {
  return <div className="flex flex-col gap-3">{blocks(body)}</div>;
}

function blocks(body: string): ReactNode[] {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // Fenced code. Held verbatim — the whole point of a fence is that what is
    // inside it is not interpreted.
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) {
        body.push(lines[i]!);
        i += 1;
      }
      i += 1; // the closing fence, if there was one
      out.push(
        <pre
          key={key++}
          className="overflow-x-auto rounded-md bg-surface-2 p-3 text-meta text-text"
        >
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const depth = heading[1]!.length;
      const text = heading[2]!;
      // A page's own headings start at h2: the page title is the h1, and two
      // h1s on a screen leaves a screen-reader user with no outline.
      const Tag = (["h2", "h3", "h4", "h5"] as const)[depth - 1]!;
      const size = ["text-[19px]", "text-[17px]", "text-ui", "text-ui"][depth - 1]!;
      out.push(
        <Tag key={key++} className={`${size} font-semibold text-text`}>
          {inline(text)}
        </Tag>,
      );
      i += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) {
        quoted.push(lines[i]!.replace(/^>\s?/, ""));
        i += 1;
      }
      out.push(
        <blockquote
          key={key++}
          className="border-l-2 border-border pl-3 text-ui text-muted"
        >
          {inline(quoted.join(" "))}
        </blockquote>,
      );
      continue;
    }

    const bullet = /^[-*+]\s+/;
    const numbered = /^\d+[.)]\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const marker = ordered ? numbered : bullet;
      const items: string[] = [];
      while (i < lines.length && marker.test(lines[i]!)) {
        items.push(lines[i]!.replace(marker, ""));
        i += 1;
      }
      const List = ordered ? "ol" : "ul";
      out.push(
        <List
          key={key++}
          className={`flex flex-col gap-1 pl-5 text-ui text-text ${ordered ? "list-decimal" : "list-disc"}`}
        >
          {items.map((item, n) => (
            <li key={n}>{inline(item)}</li>
          ))}
        </List>,
      );
      continue;
    }

    // A paragraph runs to the next blank line.
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "" && !/^(#{1,4}\s|>|```)/.test(lines[i]!)) {
      para.push(lines[i]!);
      i += 1;
    }
    out.push(
      <p key={key++} className="text-ui leading-relaxed text-text">
        {inline(para.join(" "))}
      </p>,
    );
  }

  return out;
}

/** Only schemes that cannot execute. `javascript:` and `data:` are refused. */
function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  // In-app addresses, which is how one page links to another.
  if (trimmed.startsWith("#/") || trimmed.startsWith("/")) return trimmed;
  return null;
}

const INLINE = /(\[[^\]]*\]\([^)\s]*\)|`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|_[^_]+_)/g;

function inline(text: string): ReactNode {
  const parts = text.split(INLINE).filter((part) => part !== "");
  return (
    <>
      {parts.map((part, i) => {
        const link = /^\[([^\]]*)\]\(([^)\s]*)\)$/.exec(part);
        if (link) {
          const href = safeHref(link[2]!);
          // Refused schemes render as the characters the author typed, so they
          // can see what is there rather than watching a link silently vanish.
          if (!href) return <Fragment key={i}>{part}</Fragment>;
          const external = /^https?:/i.test(href);
          return (
            <a
              key={i}
              href={href}
              className="text-action underline underline-offset-2"
              // `noreferrer` as well as `noopener`: a page in the record
              // linking out must not tell the destination where it came from.
              {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
            >
              {link[1]}
            </a>
          );
        }
        if (part.startsWith("`") && part.endsWith("`")) {
          return (
            <code key={i} className="rounded-sm bg-surface-2 px-1 text-[0.95em]">
              {part.slice(1, -1)}
            </code>
          );
        }
        if (part.startsWith("**") && part.endsWith("**")) {
          return <strong key={i}>{part.slice(2, -2)}</strong>;
        }
        if (
          (part.startsWith("*") && part.endsWith("*")) ||
          (part.startsWith("_") && part.endsWith("_"))
        ) {
          return <em key={i}>{part.slice(1, -1)}</em>;
        }
        return <Fragment key={i}>{part}</Fragment>;
      })}
    </>
  );
}
