// A small, tolerant, dependency-free HTML reader and Markdown writer.
//
// Import fidelity is the risk named in CORE-PLAN.md section 7: "if a partner's
// Confluence import arrives mangled, the record starts life untrusted". This
// file is where that is decided, so it is deliberately careful about the two
// things that matter and deliberately blunt about everything else:
//
//   1. It never emits HTML. The parser produces a node tree and the writer only
//      ever emits text taken from text nodes, so no markup from the source can
//      reach a page body — including markup hidden inside <script>, <style>, or
//      an attribute. What survives is the reading order and the structure.
//   2. It never throws on malformed markup. Unclosed tags, stray closing tags,
//      uppercase tags, unquoted attributes, truncated documents, and bare "<"
//      in text are all normal in real exports. Every one of them parses.
//
// The output target is the same safe-subset Markdown the Canon editor and the
// web UI already speak (see public/app.js): headings, bold, italics, lists,
// links, inline code, fenced code blocks, blockquotes. Tables are emitted as
// GFM pipe tables, which the current UI renders as plain text but which reads
// correctly and is exactly what a table renderer would want later.
//
// Deliberately not done: backslash-escaping of Markdown punctuation. The
// renderer on the other side does not process backslash escapes, so escaping
// would show the reader a backslash instead of protecting anything. The one
// exception is "|" inside a table cell, which is escaped because it would
// otherwise break the column count for any consumer that does parse tables.

export interface ElementNode {
  kind: 'element';
  tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
}

export interface TextNode {
  kind: 'text';
  text: string;
}

export type HtmlNode = ElementNode | TextNode;

export function isElement(node: HtmlNode): node is ElementNode {
  return node.kind === 'element';
}

// ---------------------------------------------------------------------------
// Entities

// A working set, not the full HTML5 table: the entities that actually turn up
// in Confluence and Google Docs exports. Anything unknown is left as written,
// which is the tolerant choice — a literal "&foo;" in a body is a cosmetic
// blemish, while a wrong guess is a content error.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  // Non-breaking space becomes an ordinary space on purpose: an invisible
  // U+00A0 in a page body is a trap for every later reader and search index.
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  shy: '',
  zwnj: '',
  zwj: '',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  minus: '−',
  lsquo: '‘',
  rsquo: '’',
  sbquo: '‚',
  ldquo: '“',
  rdquo: '”',
  bdquo: '„',
  bull: '•',
  middot: '·',
  sect: '§',
  para: '¶',
  dagger: '†',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  plusmn: '±',
  times: '×',
  divide: '÷',
  frac12: '½',
  frac14: '¼',
  laquo: '«',
  raquo: '»',
  larr: '←',
  rarr: '→',
  harr: '↔',
  crarr: '↵',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  eacute: 'é',
  egrave: 'è',
  agrave: 'à',
  ccedil: 'ç',
  uuml: 'ü',
  ouml: 'ö',
  auml: 'ä',
  szlig: 'ß',
  ntilde: 'ñ',
  check: '✓',
};

const ENTITY = /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g;
// Legacy, semicolon-free forms. Real exports contain "&nbsp" and "AT&T" alike,
// so the lookahead keeps "AT&T Corp" intact while fixing "a&nbsp b".
const LOOSE_ENTITY = /&(amp|lt|gt|quot|nbsp)(?![a-zA-Z0-9;])/g;

function codePoint(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0 || value > 0x10ffff) return null;
  if (value >= 0xd800 && value <= 0xdfff) return null; // lone surrogate
  try {
    return String.fromCodePoint(value);
  } catch {
    return null;
  }
}

export function decodeEntities(input: string): string {
  if (!input.includes('&')) return input;
  const once = input.replace(ENTITY, (match, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const value = hex ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return codePoint(value) ?? match;
    }
    const named = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
  return once.replace(LOOSE_ENTITY, (_match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? _match);
}

// ---------------------------------------------------------------------------
// Parser

const VOID_TAGS = new Set([
  'area',
  'base',
  'basefont',
  'br',
  'col',
  'embed',
  'frame',
  'hr',
  'img',
  'input',
  'isindex',
  'keygen',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

// Elements whose content is text, not markup. Everything up to the matching
// close tag is taken verbatim, which is what keeps "<script>a < b</script>"
// from tearing the document apart.
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'plaintext']);

// Opening one of these closes an open <p>.
const CLOSES_PARAGRAPH = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'details',
  'div',
  'dl',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);

// Opening the key implies closing any of the listed elements still open.
const IMPLIED_END: Record<string, string[]> = {
  li: ['li'],
  dt: ['dt', 'dd'],
  dd: ['dt', 'dd'],
  tr: ['td', 'th', 'tr'],
  td: ['td', 'th'],
  th: ['td', 'th'],
  thead: ['td', 'th', 'tr'],
  tbody: ['td', 'th', 'tr', 'thead'],
  tfoot: ['td', 'th', 'tr', 'tbody', 'thead'],
  option: ['option'],
  optgroup: ['option', 'optgroup'],
  p: ['p'],
};

const TAG_NAME = /[a-zA-Z][a-zA-Z0-9:_.-]*/y;
const ATTR = /\s*([^\s"'>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'`=<>]*))?/y;

function element(tag: string, attrs: Record<string, string> = {}): ElementNode {
  return { kind: 'element', tag, attrs, children: [] };
}

/**
 * Parse a document into a node tree. Never throws: anything that is not
 * recognisable markup becomes text.
 */
export function parseHtml(source: string): ElementNode {
  const src = String(source ?? '').replace(/\r\n?/g, '\n');
  const root = element('#document');
  const stack: ElementNode[] = [root];
  const top = (): ElementNode => stack[stack.length - 1]!;
  let buffer = '';
  let i = 0;

  const flushText = (): void => {
    if (!buffer) return;
    top().children.push({ kind: 'text', text: decodeEntities(buffer) });
    buffer = '';
  };

  const closeTag = (name: string): void => {
    for (let s = stack.length - 1; s > 0; s--) {
      if (stack[s]!.tag === name) {
        stack.length = s;
        return;
      }
    }
    // A stray close tag naming nothing that is open is simply dropped.
  };

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      buffer += src.slice(i);
      break;
    }
    buffer += src.slice(i, lt);

    const rest = src.slice(lt);
    if (rest.startsWith('<!--')) {
      const end = src.indexOf('-->', lt + 4);
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (rest.startsWith('<![CDATA[')) {
      const end = src.indexOf(']]>', lt + 9);
      buffer += src.slice(lt + 9, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (rest.startsWith('<!') || rest.startsWith('<?')) {
      const end = src.indexOf('>', lt + 2);
      i = end === -1 ? src.length : end + 1;
      continue;
    }

    const closing = rest.startsWith('</');
    TAG_NAME.lastIndex = lt + (closing ? 2 : 1);
    const nameMatch = TAG_NAME.exec(src);
    if (!nameMatch || nameMatch.index !== lt + (closing ? 2 : 1)) {
      // "<" that starts no tag at all: 3 < 4, or a truncated document.
      buffer += '<';
      i = lt + 1;
      continue;
    }
    const tag = nameMatch[0].toLowerCase();
    let cursor = TAG_NAME.lastIndex;

    if (closing) {
      const end = src.indexOf('>', cursor);
      i = end === -1 ? src.length : end + 1;
      flushText();
      if (tag === 'br') {
        // </br> in the wild means <br>.
        top().children.push(element('br'));
      } else {
        closeTag(tag);
      }
      continue;
    }

    // Attributes.
    const attrs: Record<string, string> = {};
    let selfClosing = false;
    for (;;) {
      if (cursor >= src.length) break;
      const ch = src[cursor]!;
      if (ch === '>') {
        cursor += 1;
        break;
      }
      if (ch === '/' && src[cursor + 1] === '>') {
        selfClosing = true;
        cursor += 2;
        break;
      }
      if (ch === '/' || /\s/.test(ch)) {
        cursor += 1;
        continue;
      }
      ATTR.lastIndex = cursor;
      const attrMatch = ATTR.exec(src);
      if (!attrMatch || attrMatch.index !== cursor || attrMatch[0].length === 0) {
        cursor += 1;
        continue;
      }
      const key = attrMatch[1]!.toLowerCase();
      let value = attrMatch[2] ?? '';
      if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'"))) value = value.slice(1, -1);
      if (!(key in attrs)) attrs[key] = decodeEntities(value);
      cursor = ATTR.lastIndex;
    }
    i = cursor;

    flushText();

    if (RAW_TEXT_TAGS.has(tag)) {
      const close = new RegExp(`</${tag}\\s*>`, 'i');
      const remainder = src.slice(i);
      const found = close.exec(remainder);
      const raw = found ? remainder.slice(0, found.index) : remainder;
      i = found ? i + found.index + found[0].length : src.length;
      const node = element(tag, attrs);
      // Script and style content is never text of the document; it is dropped
      // by the writer, but keeping it here costs nothing and keeps the tree
      // faithful for anyone inspecting it.
      node.children.push({ kind: 'text', text: tag === 'script' || tag === 'style' ? raw : decodeEntities(raw) });
      top().children.push(node);
      continue;
    }

    const implied = IMPLIED_END[tag];
    const closesP = CLOSES_PARAGRAPH.has(tag);
    while (stack.length > 1) {
      const openTag = top().tag;
      const byImplication = implied?.includes(openTag) ?? false;
      if (byImplication || (closesP && openTag === 'p')) stack.pop();
      else break;
    }

    const node = element(tag, attrs);
    top().children.push(node);
    if (!selfClosing && !VOID_TAGS.has(tag)) stack.push(node);
  }
  flushText();
  return root;
}

// ---------------------------------------------------------------------------
// Tree helpers

export function attr(node: ElementNode, name: string): string | null {
  return node.attrs[name] ?? null;
}

export function classList(node: ElementNode): string[] {
  return (node.attrs.class ?? '').split(/\s+/).filter(Boolean);
}

export function hasClass(node: ElementNode, name: string): boolean {
  return classList(node).includes(name);
}

/** Depth-first walk over every element in the tree, root included. */
export function* walk(node: HtmlNode): Generator<ElementNode> {
  if (!isElement(node)) return;
  yield node;
  for (const child of node.children) yield* walk(child);
}

export function getElementById(root: HtmlNode, id: string): ElementNode | null {
  for (const el of walk(root)) if (el.attrs.id === id) return el;
  return null;
}

export function getElementsByTag(root: HtmlNode, tag: string): ElementNode[] {
  const out: ElementNode[] = [];
  for (const el of walk(root)) if (el.tag === tag) out.push(el);
  return out;
}

export function firstByTag(root: HtmlNode, tag: string): ElementNode | null {
  for (const el of walk(root)) if (el.tag === tag) return el;
  return null;
}

/** Plain text of a subtree, whitespace collapsed. Script and style excluded. */
export function textContent(node: HtmlNode): string {
  return rawTextOf(node, false).replace(/\s+/g, ' ').trim();
}

function rawTextOf(node: HtmlNode, preserve: boolean): string {
  if (!isElement(node)) return node.text;
  if (node.tag === 'script' || node.tag === 'style') return '';
  let out = '';
  for (const child of node.children) {
    if (isElement(child) && child.tag === 'br') out += '\n';
    else out += rawTextOf(child, preserve);
  }
  return out;
}

/** Remove every element the predicate accepts, in place. */
export function removeElements(root: ElementNode, predicate: (el: ElementNode) => boolean): void {
  root.children = root.children.filter((child) => !(isElement(child) && predicate(child)));
  for (const child of root.children) if (isElement(child)) removeElements(child, predicate);
}

// ---------------------------------------------------------------------------
// Style-sheet reading (Google Docs)
//
// A Google Docs HTML export carries no <b> or <i>. Every run is a
// <span class="c3">, and the meaning lives in a <style> block:
// ".c3{font-weight:700}". Without reading that sheet, an entire corpus arrives
// with its emphasis silently deleted, so the sheet is read.

export interface StyleClasses {
  bold: Set<string>;
  italic: Set<string>;
  mono: Set<string>;
  heading: Map<string, number>;
}

const RULE = /([^{}]+)\{([^{}]*)\}/g;

export function classesFromStyleSheet(css: string): StyleClasses {
  const result: StyleClasses = { bold: new Set(), italic: new Set(), mono: new Set(), heading: new Map() };
  if (!css) return result;
  // Strip comments and any @media/@page wrapper braces we do not care about.
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '');
  RULE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = RULE.exec(flat))) {
    const selectors = match[1]!.split(',').map((s) => s.trim());
    const body = match[2]!.toLowerCase();
    const weight = /font-weight\s*:\s*(bold|[5-9]00)\b/.test(body);
    const italic = /font-style\s*:\s*italic\b/.test(body);
    const mono = /font-family\s*:[^;]*(courier|consolas|monospace|"roboto mono"|'roboto mono')/.test(body);
    if (!weight && !italic && !mono) continue;
    for (const selector of selectors) {
      const name = /^\.([A-Za-z0-9_-]+)$/.exec(selector)?.[1];
      if (!name) continue;
      if (weight) result.bold.add(name);
      if (italic) result.italic.add(name);
      if (mono) result.mono.add(name);
    }
  }
  return result;
}

/** Collect and merge every <style> block in a document. */
export function styleClassesOf(root: HtmlNode): StyleClasses {
  const merged: StyleClasses = { bold: new Set(), italic: new Set(), mono: new Set(), heading: new Map() };
  for (const style of getElementsByTag(root, 'style')) {
    const css = style.children.map((c) => (isElement(c) ? '' : c.text)).join('');
    const parsed = classesFromStyleSheet(css);
    for (const name of parsed.bold) merged.bold.add(name);
    for (const name of parsed.italic) merged.italic.add(name);
    for (const name of parsed.mono) merged.mono.add(name);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Markdown writer

export interface MarkdownOptions {
  /** Class names that mean bold / italic / monospace (see styleClassesOf). */
  styles?: StyleClasses;
  /** Rewrite a link target, e.g. to unwrap a Google redirect. */
  rewriteHref?: (href: string) => string;
}

// Elements that never contribute text.
const DROPPED = new Set([
  'script',
  'style',
  'head',
  'meta',
  'link',
  'base',
  'noscript',
  'iframe',
  'object',
  'embed',
  'svg',
  'canvas',
  'button',
  'input',
  'select',
  'option',
  'textarea',
  'map',
  'area',
  'col',
  'colgroup',
]);

const BLOCK = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'body',
  'center',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'html',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);

const MAX_DEPTH = 64;

interface WriteContext {
  options: MarkdownOptions;
  depth: number;
}

/** Convert a parsed tree (or a subtree) to safe-subset Markdown. */
export function toMarkdown(node: HtmlNode, options: MarkdownOptions = {}): string {
  const ctx: WriteContext = { options, depth: 0 };
  const blocks = isElement(node) ? renderBlocks(node.children, ctx) : [textOf(node)];
  return normalise(blocks.filter((b) => b.trim().length > 0).join('\n\n'));
}

/** Parse and convert in one step. */
export function htmlToMarkdown(source: string, options: MarkdownOptions = {}): string {
  return toMarkdown(parseHtml(source), options);
}

function normalise(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function textOf(node: HtmlNode): string {
  return isElement(node) ? '' : node.text;
}

function hidden(el: ElementNode): boolean {
  const style = (el.attrs.style ?? '').toLowerCase();
  return /display\s*:\s*none/.test(style) || 'hidden' in el.attrs;
}

function renderBlocks(nodes: HtmlNode[], ctx: WriteContext): string[] {
  const out: string[] = [];
  let inline = '';
  const flush = (): void => {
    const text = collapse(inline);
    if (text) out.push(text);
    inline = '';
  };
  for (const node of nodes) {
    if (!isElement(node)) {
      inline += node.text;
      continue;
    }
    if (DROPPED.has(node.tag) || hidden(node)) continue;
    if (BLOCK.has(node.tag)) {
      flush();
      out.push(...renderBlock(node, ctx));
    } else {
      inline += renderInline(node, ctx);
    }
  }
  flush();
  return out.filter((block) => block.trim().length > 0);
}

function collapse(text: string): string {
  // Collapse runs of whitespace but keep the hard breaks <br> produced.
  return text
    .replace(/[^\S\n]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function renderBlock(el: ElementNode, ctx: WriteContext): string[] {
  if (ctx.depth > MAX_DEPTH) {
    const text = textContent(el);
    return text ? [text] : [];
  }
  const inner: WriteContext = { options: ctx.options, depth: ctx.depth + 1 };

  switch (el.tag) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      const level = Number(el.tag[1]);
      const text = collapse(renderInlineChildren(el, inner)).replace(/\n+/g, ' ');
      return text ? [`${'#'.repeat(level)} ${text}`] : [];
    }
    case 'hr':
      return ['---'];
    case 'pre':
      return renderPre(el);
    case 'ul':
    case 'ol':
      return renderList(el, el.tag === 'ol', inner);
    case 'li': {
      // A stray <li> outside any list still reads as an item.
      const blocks = renderBlocks(el.children, inner);
      return blocks.length ? [indentContinuation(`- ${blocks.join('\n')}`, 2)] : [];
    }
    case 'table':
      return renderTable(el, inner);
    case 'blockquote':
      return quote(renderBlocks(el.children, inner));
    case 'dl':
      return renderDefinitionList(el, inner);
    case 'dt': {
      const text = collapse(renderInlineChildren(el, inner));
      return text ? [`**${text}**`] : [];
    }
    default: {
      // Confluence wraps its info/note/warning macros in a div; a blockquote is
      // the closest thing the safe subset has to a callout.
      if (classList(el).some((c) => c.startsWith('confluence-information-macro') || c === 'panelContent')) {
        if (classList(el).includes('confluence-information-macro')) {
          return quote(renderBlocks(el.children, inner));
        }
      }
      return renderBlocks(el.children, inner);
    }
  }
}

function quote(blocks: string[]): string[] {
  const text = blocks.join('\n\n');
  if (!text.trim()) return [];
  return [
    text
      .split('\n')
      .map((line) => (line.length ? `> ${line}` : '>'))
      .join('\n'),
  ];
}

function indentContinuation(text: string, width: number): string {
  const [first, ...rest] = text.split('\n');
  return [first ?? '', ...rest.map((line) => (line.length ? ' '.repeat(width) + line : ''))].join('\n');
}

function renderList(el: ElementNode, ordered: boolean, ctx: WriteContext): string[] {
  const lines: string[] = [];
  let n = Number.parseInt(el.attrs.start ?? '1', 10);
  if (!Number.isFinite(n) || n < 1) n = 1;
  for (const child of el.children) {
    if (!isElement(child)) continue;
    if (child.tag === 'li') {
      const marker = ordered ? `${n++}. ` : '- ';
      const body = renderBlocks(child.children, ctx).join('\n');
      const text = body.trim().length ? body : '';
      lines.push(indentContinuation(marker + text, marker.length).replace(/\s+$/, ''));
    } else if (child.tag === 'ul' || child.tag === 'ol') {
      // A list nested directly in a list, with no <li> between: keep it.
      for (const block of renderList(child, child.tag === 'ol', ctx)) {
        lines.push(
          block
            .split('\n')
            .map((line) => (line.length ? '  ' + line : ''))
            .join('\n'),
        );
      }
    } else if (BLOCK.has(child.tag)) {
      lines.push(...renderBlock(child, ctx));
    }
  }
  const text = lines.filter((line) => line.trim().length > 0).join('\n');
  return text ? [text] : [];
}

function renderDefinitionList(el: ElementNode, ctx: WriteContext): string[] {
  const lines: string[] = [];
  for (const child of el.children) {
    if (!isElement(child)) continue;
    const text = collapse(renderInlineChildren(child, ctx)).replace(/\n+/g, ' ');
    if (!text) continue;
    if (child.tag === 'dt') lines.push(`**${text}**`);
    else if (child.tag === 'dd') lines.push(`  ${text}`);
  }
  return lines.length ? [lines.join('\n')] : [];
}

const LANGUAGE_HINT = /(?:^|\s)(?:brush|language|lang)\s*[:=]\s*([a-z0-9+#-]+)/i;

function renderPre(el: ElementNode): string[] {
  const raw = rawTextOf(el, true).replace(/^\n+/, '').replace(/\s+$/, '');
  if (!raw.trim()) return [];
  const hints = [el.attrs['data-syntaxhighlighter-params'] ?? '', el.attrs.class ?? '', el.attrs['data-lang'] ?? ''];
  let language = '';
  for (const hint of hints) {
    const found = LANGUAGE_HINT.exec(hint);
    if (found?.[1] && found[1] !== 'pre') {
      language = found[1].toLowerCase();
      break;
    }
  }
  // A body containing a fence of its own gets a longer fence, never a broken one.
  const longest = /(`{3,})/.exec(raw)?.[1]?.length ?? 0;
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return [`${fence}${language}\n${raw}\n${fence}`];
}

function tableRows(el: ElementNode, out: ElementNode[] = []): ElementNode[] {
  for (const child of el.children) {
    if (!isElement(child)) continue;
    if (child.tag === 'tr') out.push(child);
    else if (child.tag === 'thead' || child.tag === 'tbody' || child.tag === 'tfoot') tableRows(child, out);
  }
  return out;
}

function renderTable(el: ElementNode, ctx: WriteContext): string[] {
  const out: string[] = [];
  const caption = el.children.find((c): c is ElementNode => isElement(c) && c.tag === 'caption');
  if (caption) {
    const text = collapse(renderInlineChildren(caption, ctx)).replace(/\n+/g, ' ');
    if (text) out.push(`**${text}**`);
  }
  const rows = tableRows(el);
  const grid: string[][] = [];
  for (const row of rows) {
    const cells: string[] = [];
    for (const cell of row.children) {
      if (!isElement(cell) || (cell.tag !== 'td' && cell.tag !== 'th')) continue;
      const text = renderBlocks(cell.children, ctx)
        .join(' ')
        .replace(/\s*\n\s*/g, ' ')
        .replace(/\|/g, '\\|')
        .trim();
      const span = Number.parseInt(cell.attrs.colspan ?? '1', 10);
      cells.push(text);
      // A spanned cell keeps the columns lined up by padding to its width.
      for (let k = 1; Number.isFinite(span) && k < span && k < 32; k++) cells.push('');
    }
    if (cells.length) grid.push(cells);
  }
  if (!grid.length) {
    // A table with no rows still may hold text (malformed markup).
    const fallback = renderBlocks(el.children, ctx);
    return [...out, ...fallback];
  }
  const width = Math.max(...grid.map((row) => row.length));
  const padded = grid.map((row) => [...row, ...Array<string>(width - row.length).fill('')]);
  const header = padded[0]!;
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...padded.slice(1).map((row) => `| ${row.join(' | ')} |`),
  ];
  out.push(lines.join('\n'));
  return out;
}

// ---------------------------------------------------------------------------
// Inline

function renderInlineChildren(el: ElementNode, ctx: WriteContext): string {
  let out = '';
  for (const child of el.children) {
    if (!isElement(child)) {
      out += child.text;
      continue;
    }
    if (DROPPED.has(child.tag) || hidden(child)) continue;
    if (BLOCK.has(child.tag)) {
      // A block inside an inline run: flatten it rather than lose it.
      out += ' ' + renderBlock(child, { options: ctx.options, depth: ctx.depth + 1 }).join(' ') + ' ';
    } else {
      out += renderInline(child, ctx);
    }
  }
  return out;
}

function emphasisOf(el: ElementNode, ctx: WriteContext): { bold: boolean; italic: boolean; mono: boolean } {
  const styles = ctx.options.styles;
  const style = (el.attrs.style ?? '').toLowerCase();
  let bold = /font-weight\s*:\s*(bold|[5-9]00)\b/.test(style);
  let italic = /font-style\s*:\s*italic\b/.test(style);
  let mono = /font-family\s*:[^;]*(courier|consolas|monospace)/.test(style);
  if (styles) {
    for (const name of classList(el)) {
      if (styles.bold.has(name)) bold = true;
      if (styles.italic.has(name)) italic = true;
      if (styles.mono.has(name)) mono = true;
    }
  }
  return { bold, italic, mono };
}

function wrap(text: string, marker: string): string {
  // Emphasis around leading or trailing space produces markup that no renderer
  // matches, so the whitespace is moved outside the markers.
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  if (!match || !match[2]) return text;
  return `${match[1]}${marker}${match[2]}${marker}${match[3]}`;
}

function code(text: string): string {
  const inner = text.replace(/\s*\n\s*/g, ' ').trim();
  if (!inner) return '';
  // The safe subset has no way to escape a backtick inside inline code, so
  // content carrying one is emitted as plain text rather than broken markup.
  if (inner.includes('`')) return inner;
  return `\`${inner}\``;
}

const UNSAFE_SCHEME = /^\s*(javascript|vbscript|file):/i;

function safeHref(raw: string, ctx: WriteContext): string | null {
  let href = raw.trim();
  if (!href) return null;
  if (ctx.options.rewriteHref) href = ctx.options.rewriteHref(href);
  if (!href || UNSAFE_SCHEME.test(href)) return null;
  if (/^data:/i.test(href)) return null;
  // The target renderer's link pattern stops at whitespace and ")", and
  // encodeURIComponent leaves parentheses alone, so they are spelled out.
  return href.replace(/[()\s]/g, (c) => (c === '(' ? '%28' : c === ')' ? '%29' : encodeURIComponent(c)));
}

function renderInline(el: ElementNode, ctx: WriteContext): string {
  const inner: WriteContext = { options: ctx.options, depth: ctx.depth + 1 };
  switch (el.tag) {
    case 'br':
      return '\n';
    case 'wbr':
      return '';
    case 'img': {
      // Images arrive as links: the export's binary files are not imported, so
      // a link records what was there and where it pointed.
      const src = safeHref(el.attrs.src ?? '', ctx);
      const alt = (el.attrs.alt ?? '').replace(/\s+/g, ' ').trim();
      if (!src) return alt;
      return `[${alt ? `Image: ${alt}` : 'Image'}](${src})`;
    }
    case 'a': {
      const text = renderInlineChildren(el, inner);
      const href = safeHref(el.attrs.href ?? '', ctx);
      const label = text.replace(/\s*\n\s*/g, ' ').replace(/[[\]]/g, '').trim();
      if (!href) return text;
      if (!label) return `[link](${href})`;
      return `[${label}](${href})`;
    }
    case 'strong':
    case 'b':
      return wrap(renderInlineChildren(el, inner), '**');
    case 'em':
    case 'i':
    case 'cite':
    case 'dfn':
      return wrap(renderInlineChildren(el, inner), '*');
    case 'code':
    case 'tt':
    case 'kbd':
    case 'samp':
    case 'var':
      return code(rawTextOf(el, false));
    default: {
      const text = renderInlineChildren(el, inner);
      const { bold, italic, mono } = emphasisOf(el, ctx);
      if (mono && !/[`]/.test(text)) return code(text);
      let out = text;
      if (italic) out = wrap(out, '*');
      if (bold) out = wrap(out, '**');
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// Document-level convenience

/** The document title: <title> first, then the first heading. */
export function documentTitle(root: HtmlNode): string | null {
  const title = firstByTag(root, 'title');
  const fromTitle = title ? textContent(title) : '';
  if (fromTitle) return fromTitle;
  for (const level of ['h1', 'h2']) {
    const heading = firstByTag(root, level);
    const text = heading ? textContent(heading) : '';
    if (text) return text;
  }
  return null;
}
