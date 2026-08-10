import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { forbiddenRole } from './abilities.js';
import { extractZip } from './zip.js';
import {
  Actor,
  CanonError,
  Draft,
  DocType,
  DOC_TYPES,
  Page,
  PageFields,
  Role,
  ROLE_RANK,
  TYPE_RULES,
} from './model.js';
import {
  ElementNode,
  HtmlNode,
  attr,
  classList,
  documentTitle,
  firstByTag,
  getElementById,
  getElementsByTag,
  isElement,
  parseHtml,
  removeElements,
  styleClassesOf,
  textContent,
  toMarkdown,
  truncationNote,
  walk,
} from './html.js';

// Import (CORE-PLAN.md Epic E, M4): "Importers for Confluence and Google Docs
// in Core, preserving page structure and trees where they exist. Everything
// arrives as Draft Notes or Draft pages of a chosen type. Nothing becomes
// Canonical without passing through review."
//
// Both importers read an already-unpacked export directory. ZIP handling is
// deliberately not here: the operator unzips first (see server/README.md,
// "Importing"). One less thing between a partner's corpus and the record, and
// one less format to get wrong.
//
// The rules every import obeys, each of which has a test:
//   - every imported page arrives as status 'draft', never Canonical;
//   - the importing actor is the creator of every page it makes;
//   - each run has an id and writes import.start / import.page / import.finish
//     audit events naming the source system, the file, and the page;
//   - a run is idempotent per (run id, source path): re-running the same run id
//     skips files whose content is unchanged and writes a new version for files
//     whose content changed. It never creates the page twice;
//   - a file that fails to parse is reported in the summary and the run
//     continues.

export const IMPORTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS import_runs (
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL,
  path          TEXT NOT NULL,
  collection_id TEXT NOT NULL REFERENCES collections(id),
  type          TEXT NOT NULL,
  actor_id      TEXT NOT NULL REFERENCES actors(id),
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  summary_json  TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS import_items (
  run_id       TEXT NOT NULL REFERENCES import_runs(id),
  source_path  TEXT NOT NULL,
  page_id      TEXT REFERENCES pages(id),
  content_hash TEXT NOT NULL,
  outcome      TEXT NOT NULL,
  reason       TEXT,
  at           TEXT NOT NULL,
  PRIMARY KEY (run_id, source_path)
);

CREATE INDEX IF NOT EXISTS idx_import_items_page ON import_items(page_id);
`;

export type ImportSource = 'confluence' | 'google-docs';
export const IMPORT_SOURCES: readonly ImportSource[] = ['confluence', 'google-docs'];

export type ImportOutcome = 'imported' | 'updated' | 'skipped' | 'failed';

export interface ImportFileResult {
  file: string; // path relative to the export root, POSIX separators
  outcome: ImportOutcome;
  pageId: string | null;
  title: string | null;
  parentFile: string | null;
  /** True when the body was written as version 1 (or a new version). */
  published: boolean;
  reason: string | null;
}

export interface ImportSummary {
  runId: string;
  source: ImportSource;
  path: string;
  collectionId: string;
  type: DocType;
  actorId: string;
  /** How the page tree was recovered: from the export index, from page
   *  breadcrumbs, or not at all (a flat import). */
  hierarchy: 'tree' | 'breadcrumbs' | 'flat';
  startedAt: string;
  finishedAt: string;
  counts: { found: number; imported: number; updated: number; skipped: number; failed: number };
  files: ImportFileResult[];
}

export interface ImportRunRecord extends ImportSummary {
  items: { file: string; pageId: string | null; outcome: ImportOutcome; reason: string | null; at: string }[];
}

// ---------------------------------------------------------------------------
// Where an import may read from
//
// The export path is operator input, walked and read by the server. Two things
// follow, and both are enforced below rather than assumed:
//
//   1. A run never reads outside the directory it was pointed at. Discovery
//      builds paths only from directory-entry names, so no `..` can appear in
//      one — but a SYMLINK inside an otherwise ordinary export is a file named
//      `Onboarding.html` whose contents are `/etc/passwd`, and following it
//      would import that file into the record as a page. Every file is
//      therefore resolved through realpath and refused if it lands outside the
//      run's own root. A refused file is reported like any other bad file; it
//      never aborts the run.
//
//   2. A deployment can bound the roots themselves. CANON_IMPORT_ROOTS, a
//      colon- or comma-separated list of directories, restricts every import to
//      paths inside them. UNSET MEANS UNRESTRICTED, which is the historical
//      behaviour and is why this is opt-in rather than default-deny: an
//      operator running the importer by hand from an arbitrary unpack
//      directory is the normal case. Any deployment where `edit` on a
//      collection is not the same trust level as shell access should set it.
//      See SECURITY.md.

function importRootsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.CANON_IMPORT_ROOTS ?? '')
    .split(/[:,]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => realPathOr(resolve(p)));
}

/** realpath where it resolves, the path itself where it does not. */
function realPathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Is `path` the directory `root` itself, or something beneath it? */
function within(root: string, path: string): boolean {
  if (path === root) return true;
  const rel = relative(root, path);
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

// A run reads at most this many documents. An export directory is operator
// input, so the cap is what keeps a mis-aimed path (a home directory, say) from
// becoming an unbounded job. Files past the cap are reported as skipped.
export const MAX_FILES_PER_RUN = 2000;
// A single document larger than this is skipped rather than parsed. Real
// Confluence and Google Docs pages are far below it.
export const MAX_FILE_BYTES = 4 * 1024 * 1024;

// The minimal slice of CanonStore the importer needs; CanonStore satisfies it.
export interface ImportHost {
  getActor(id: string): Actor;
  roleOf(actorId: string, collectionId: string): Role | null;
  createPage(
    actorId: string,
    input: { collectionId: string; parentId?: string | null; type: DocType; title: string },
  ): Page;
  editDraft(actorId: string, pageId: string, input: { title?: string; body?: string; fields?: PageFields }): Draft;
  publish(actorId: string, pageId: string, input?: { note?: string }): Page;
}

function now(): string {
  return new Date().toISOString();
}

function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function posix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

// ---------------------------------------------------------------------------
// Discovery: what documents an export holds, and how they nest

interface DiscoveredDocument {
  file: string; // relative to the export root
  absPath: string;
  /** Title recovered from the export's own index, when it has one. */
  indexTitle: string | null;
  parentFile: string | null;
}

interface Discovery {
  documents: DiscoveredDocument[]; // parents always before their children
  hierarchy: ImportSummary['hierarchy'];
  spaceName: string | null;
  skipped: { file: string; reason: string }[];
}

function isHtmlFile(name: string): boolean {
  const ext = extname(name).toLowerCase();
  return ext === '.html' || ext === '.htm';
}

/**
 * Read a file only if it really lives under `realRoot`. Discovery reads the
 * export's index and its pages' breadcrumbs before the import pass ever runs,
 * so the containment rule has to hold here too: an index.html symlinked at
 * another file would otherwise be parsed, and its text would reach the record
 * as a space name or a page title.
 */
function readContained(realRoot: string, absPath: string): string {
  if (!within(realRoot, realPathOr(absPath))) {
    throw new Error('this file resolves outside the export directory');
  }
  return readFileSync(absPath, 'utf8');
}

function readDirSafe(dir: string): { name: string; isDirectory: boolean }[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    }));
  } catch {
    return [];
  }
}

/** The file a Confluence-style href points at, ignoring query and fragment. */
function hrefTarget(href: string | null): string | null {
  if (!href) return null;
  const clean = href.split('#')[0]!.split('?')[0]!.trim();
  if (!clean || /^[a-z][a-z0-9+.-]*:/i.test(clean)) return null; // absolute URL, not a file
  let decoded = clean;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    // A malformed escape sequence; use the raw text.
  }
  const name = basename(decoded.split('/').pop() ?? decoded);
  return isHtmlFile(name) ? name : null;
}

/** The first <a> inside an <li> that is not inside a nested list. */
function ownLink(li: ElementNode): ElementNode | null {
  const queue: HtmlNode[] = [...li.children];
  while (queue.length) {
    const node = queue.shift()!;
    if (!isElement(node)) continue;
    if (node.tag === 'ul' || node.tag === 'ol') continue;
    if (node.tag === 'a') return node;
    queue.push(...node.children);
  }
  return null;
}

interface IndexEntry {
  file: string;
  title: string | null;
  children: IndexEntry[];
}

function readIndexList(list: ElementNode): IndexEntry[] {
  const entries: IndexEntry[] = [];
  for (const child of list.children) {
    if (!isElement(child) || child.tag !== 'li') continue;
    const link = ownLink(child);
    const target = hrefTarget(link ? attr(link, 'href') : null);
    const nested: IndexEntry[] = [];
    for (const sub of child.children) {
      if (isElement(sub) && (sub.tag === 'ul' || sub.tag === 'ol')) nested.push(...readIndexList(sub));
    }
    if (!target) {
      // A grouping item with no link of its own: lift its children.
      entries.push(...nested);
      continue;
    }
    entries.push({ file: target, title: link ? textContent(link) || null : null, children: nested });
  }
  return entries;
}

/** The <ul> in a Confluence index.html that holds the page tree. */
function findIndexList(root: ElementNode): ElementNode | null {
  // Preferred: the list that follows the "Available Pages:" header, which is
  // what a Confluence HTML space export writes.
  for (const el of walk(root)) {
    const children = el.children.filter(isElement);
    for (let i = 0; i < children.length; i++) {
      const node = children[i]!;
      if (!/^h[1-6]$/.test(node.tag)) continue;
      if (!/available pages/i.test(textContent(node))) continue;
      for (let j = i + 1; j < children.length; j++) {
        const next = children[j]!;
        if (next.tag === 'ul' || next.tag === 'ol') return next;
        // The header and the list are often separated by a wrapper div.
        const inner = firstByTag(next, 'ul');
        if (inner) return inner;
      }
    }
  }
  // Fallback: the list carrying the most links to other pages of the export.
  let best: ElementNode | null = null;
  let bestCount = 0;
  for (const el of walk(root)) {
    if (el.tag !== 'ul' && el.tag !== 'ol') continue;
    const count = getElementsByTag(el, 'a').filter((a) => hrefTarget(attr(a, 'href'))).length;
    if (count > bestCount) {
      best = el;
      bestCount = count;
    }
  }
  return bestCount >= 1 ? best : null;
}

/** The parent page named by a Confluence page's breadcrumb trail. */
function breadcrumbParent(root: ElementNode, self: string): string | null {
  const trail =
    getElementById(root, 'breadcrumbs') ??
    getElementById(root, 'breadcrumb-section') ??
    [...walk(root)].find((el) => classList(el).includes('breadcrumbs')) ??
    null;
  if (!trail) return null;
  const targets = getElementsByTag(trail, 'a')
    .map((a) => hrefTarget(attr(a, 'href')))
    .filter((t): t is string => Boolean(t))
    .filter((t) => t.toLowerCase() !== 'index.html' && t !== self);
  return targets.length ? targets[targets.length - 1]! : null;
}

/**
 * Order documents so a parent is always imported before its children, and
 * drop parent links that would cycle. Files whose parent is unknown sort to
 * the front in directory order.
 */
function orderByTree(files: string[], parentOf: Map<string, string>): string[] {
  const known = new Set(files);
  const parent = new Map<string, string>();
  for (const [child, above] of parentOf) {
    if (known.has(child) && known.has(above) && child !== above) parent.set(child, above);
  }
  // Break cycles: walking up must terminate.
  for (const file of [...parent.keys()]) {
    const seen = new Set<string>([file]);
    let cursor = parent.get(file);
    while (cursor) {
      if (seen.has(cursor)) {
        parent.delete(file);
        break;
      }
      seen.add(cursor);
      cursor = parent.get(cursor);
    }
  }
  const emitted = new Set<string>();
  const out: string[] = [];
  const emit = (file: string, guard: Set<string>): void => {
    if (emitted.has(file) || guard.has(file)) return;
    guard.add(file);
    const above = parent.get(file);
    if (above) emit(above, guard);
    if (emitted.has(file)) return;
    emitted.add(file);
    out.push(file);
  };
  for (const file of files) emit(file, new Set());
  return out;
}

/**
 * A Confluence HTML space export: index.html plus one file per page, with
 * attachments/, images/, and styles/ alongside. Hierarchy comes from the
 * index's nested list; pages the index does not mention fall back to their
 * breadcrumb trail; anything still unplaced lands at the root of the import.
 */
export function discoverConfluence(root: string): Discovery {
  const skipped: { file: string; reason: string }[] = [];
  const realRoot = realPathOr(root);
  const entries = readDirSafe(root);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory) continue; // attachments/, images/, styles/
    if (!isHtmlFile(entry.name)) continue;
    if (entry.name.toLowerCase() === 'index.html') continue;
    files.push(entry.name);
  }
  files.sort((a, b) => a.localeCompare(b));

  const titles = new Map<string, string>();
  const parentOf = new Map<string, string>();
  let hierarchy: Discovery['hierarchy'] = 'flat';
  let spaceName: string | null = null;

  const indexPath = entries.find((e) => !e.isDirectory && e.name.toLowerCase() === 'index.html');
  let indexOrder: string[] = [];
  if (indexPath) {
    try {
      const doc = parseHtml(readContained(realRoot, join(root, indexPath.name)));
      const heading = firstByTag(doc, 'h1');
      spaceName = heading ? textContent(heading) || null : null;
      const list = findIndexList(doc);
      if (list) {
        const walkEntries = (items: IndexEntry[], parent: string | null): void => {
          for (const item of items) {
            if (item.title) titles.set(item.file, item.title);
            if (parent) parentOf.set(item.file, parent);
            indexOrder.push(item.file);
            walkEntries(item.children, item.file);
          }
        };
        walkEntries(readIndexList(list), null);
        if (parentOf.size > 0) hierarchy = 'tree';
        else if (indexOrder.length > 0) hierarchy = 'flat';
      }
    } catch (err) {
      skipped.push({ file: 'index.html', reason: `index unreadable: ${(err as Error).message}` });
    }
  }

  // Pages the index never mentioned: ask the page itself where it sat.
  const mentioned = new Set(indexOrder);
  for (const file of files) {
    if (parentOf.has(file)) continue;
    try {
      const doc = parseHtml(readContained(realRoot, join(root, file)));
      const parent = breadcrumbParent(doc, file);
      if (parent && parent !== file) {
        parentOf.set(file, parent);
        if (hierarchy !== 'tree') hierarchy = 'breadcrumbs';
      }
    } catch {
      // Unreadable here is not fatal; the import pass reports it per file.
    }
    if (!mentioned.has(file)) indexOrder.push(file);
  }

  const ordered = orderByTree(
    // Index order first (it is the export's own reading order), then anything
    // the index did not list, in directory order.
    [...indexOrder.filter((f) => files.includes(f)), ...files.filter((f) => !indexOrder.includes(f))],
    parentOf,
  );

  const documents: DiscoveredDocument[] = ordered.map((file) => ({
    file,
    absPath: join(root, file),
    indexTitle: titles.get(file) ?? null,
    parentFile: parentOf.get(file) ?? null,
  }));
  return { documents, hierarchy, spaceName, skipped };
}

/**
 * A Google Takeout-style directory of exported Google Docs: one .html file per
 * document, flat (Google Docs has no page tree). Sub-directories are walked so
 * a Drive folder export arrives whole, but the import stays flat.
 */
export function discoverGoogleDocs(root: string): Discovery {
  const skipped: { file: string; reason: string }[] = [];
  const files: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > 6) {
      skipped.push({ file: posix(relative(root, dir)), reason: 'directory nested deeper than 6 levels' });
      return;
    }
    for (const entry of readDirSafe(dir)) {
      if (entry.name.startsWith('.')) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory) {
        if (/^(images|_files|assets)$/i.test(entry.name)) continue;
        visit(abs, depth + 1);
      } else if (isHtmlFile(entry.name)) {
        files.push(posix(relative(root, abs)));
      }
    }
  };
  visit(root, 0);
  files.sort((a, b) => a.localeCompare(b));
  return {
    documents: files.map((file) => ({
      file,
      absPath: join(root, ...file.split('/')),
      indexTitle: null,
      parentFile: null,
    })),
    hierarchy: 'flat',
    spaceName: null,
    skipped,
  };
}

// ---------------------------------------------------------------------------
// Document conversion

export interface ConvertedDocument {
  title: string;
  body: string;
  /** Where the title came from. 'filename' means the document itself yielded
   *  nothing — with an empty body too, that is a file that did not parse. */
  titleSource: 'index' | 'document' | 'filename';
}

// Confluence writes "<Space name> : <Page title>" into <title>. When the export
// has an index the space name is known and matched exactly; without one, the
// first " : " is taken as the separator, which is right for every Confluence
// export and wrong only for a page whose own title contains " : " in an export
// that also lost its index.
function stripSpacePrefix(title: string, spaceName: string | null): string {
  if (spaceName && title.startsWith(`${spaceName} : `)) return title.slice(spaceName.length + 3).trim();
  if (!spaceName && title.includes(' : ')) return title.slice(title.indexOf(' : ') + 3).trim();
  return title;
}

function titleFromFile(file: string): string {
  const name = basename(file, extname(file));
  // Confluence names files "Page+Title_1234567.html"; Takeout uses the doc title.
  return name.replace(/_\d{4,}$/, '').replace(/\+/g, ' ').trim() || name;
}

/** Confluence page HTML → title and body, with the export's chrome removed. */
export function convertConfluenceDocument(
  html: string,
  file: string,
  opts: { indexTitle?: string | null; spaceName?: string | null } = {},
): ConvertedDocument {
  const doc = parseHtml(html);
  // Chrome that is navigation, not content.
  removeElements(doc, (el) => {
    const id = el.attrs.id ?? '';
    if (['breadcrumb-section', 'footer', 'likes-and-labels-container', 'navigation'].includes(id)) return true;
    const classes = classList(el);
    if (classes.includes('page-metadata') || classes.includes('pageSectionHeader')) return true;
    // "Attachments:" sections list files this importer does not carry over.
    if (classes.includes('pageSection')) {
      const heading = firstByTag(el, 'h2');
      if (heading && /^attachments/i.test(textContent(heading))) return true;
    }
    return false;
  });

  const titleElement = getElementById(doc, 'title-text') ?? getElementById(doc, 'title-heading');
  const fromDocument =
    stripSpacePrefix(titleElement ? textContent(titleElement) : '', opts.spaceName ?? null) ||
    stripSpacePrefix(documentTitle(doc) ?? '', opts.spaceName ?? null);
  const indexTitle = (opts.indexTitle ?? '').trim();
  const title = indexTitle || fromDocument || titleFromFile(file);
  const titleSource: ConvertedDocument['titleSource'] = indexTitle
    ? 'index'
    : fromDocument
      ? 'document'
      : 'filename';

  const container =
    getElementById(doc, 'main-content') ?? getElementById(doc, 'content') ?? firstByTag(doc, 'body') ?? doc;
  const body = stripLeadingTitle(toMarkdown(container), title);
  return { title: title.trim(), body, titleSource };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Both exports repeat the document title as the first line of the body — a
// Confluence <h1> or a Google Docs <p class="title">. The page already carries
// its title, so the repeat is dropped.
function stripLeadingTitle(body: string, title: string): string {
  if (!title) return body;
  return body.replace(new RegExp(`^#{0,6}\\s*${escapeRegExp(title)}\\s*(\\n+|$)`), '');
}

/** Google's link wrapper: https://www.google.com/url?q=<real>&sa=D&... */
export function unwrapGoogleHref(href: string): string {
  const match = /^https?:\/\/(?:www\.)?google\.com\/url\?(.*)$/i.exec(href);
  if (!match) return href;
  const q = /(?:^|&)q=([^&]*)/.exec(match[1] ?? '')?.[1];
  if (!q) return href;
  try {
    return decodeURIComponent(q);
  } catch {
    return q;
  }
}

/** Google Docs export HTML → title and body, reading the export's style sheet. */
export function convertGoogleDocsDocument(html: string, file: string): ConvertedDocument {
  const doc = parseHtml(html);
  // Google Docs writes no <b>/<i>: emphasis lives in classes defined by the
  // document's own <style> block, so the sheet is read before conversion.
  const styles = styleClassesOf(doc);
  const fromDocument = (documentTitle(doc) ?? '').trim();
  const title = fromDocument || titleFromFile(file);
  const container = firstByTag(doc, 'body') ?? doc;
  const body = stripLeadingTitle(toMarkdown(container, { styles, rewriteHref: unwrapGoogleHref }), title);
  return { title: title.trim(), body, titleSource: fromDocument ? 'document' : 'filename' };
}

// ---------------------------------------------------------------------------
// The import service

export interface ImportInput {
  source: ImportSource;
  path: string;
  collectionId: string;
  type?: DocType;
  /** Re-use a run id to resume or retry an interrupted run idempotently. */
  runId?: string;
}

export interface ImportUploadInput {
  source: ImportSource;
  collectionId: string;
  type?: DocType;
  runId?: string;
  /** Where the request pipeline spooled the uploaded archive. */
  archivePath: string;
}

/**
 * Where uploaded archives unpack. Overridable because the spool briefly holds
 * a whole corpus and an operator may want it on the volume with the space —
 * but unlike an import path, nobody AIMS this: the server owns it entirely,
 * which is why runs from here skip CANON_IMPORT_ROOTS (see `run`).
 */
export function importSpoolDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CANON_IMPORT_SPOOL?.trim();
  return configured ? resolve(configured) : join(tmpdir(), 'canon-import-spool');
}

export class ImportService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly host: ImportHost,
  ) {}

  run(actorId: string, input: ImportInput, opts: { serverManagedRoot?: boolean } = {}): ImportSummary {
    const actor = this.host.getActor(actorId);
    const source = input?.source;
    if (!source || !IMPORT_SOURCES.includes(source)) {
      throw new CanonError('invalid', `Unknown import source: ${String(source)}`, { supported: IMPORT_SOURCES });
    }
    if (!input.path?.trim()) throw new CanonError('invalid', 'An import requires the path of an unpacked export');
    if (!input.collectionId) throw new CanonError('invalid', 'An import requires a target collection');
    const type = (input.type ?? 'note') as DocType;
    if (!DOC_TYPES.includes(type)) throw new CanonError('invalid', `Unknown document type: ${String(input.type)}`);
    // ADMIN, NOT EDIT (SECURITY.md R6). An import is not authoring:
    //
    //   - it names a SERVER-SIDE PATH and has the process read it. `edit` on
    //     one collection is a low bar for choosing what the server opens, and
    //     the containment rules above (realpath, CANON_IMPORT_ROOTS) bound
    //     which files are read, not who may aim the run;
    //   - it creates up to MAX_FILES_PER_RUN pages in one call, with titles
    //     and bodies taken verbatim from files nobody in Canon reviewed;
    //   - the summary it returns names the server path back to the caller.
    //
    // CORE-PLAN.md §2 puts import on the administrator's side of the line —
    // "Administrator. Sets up collections, permissions, and document types" —
    // and §4's Epic E files it under "Trust and arrival" with the audit log
    // rather than under Epic B's daily writing loop. A contributor who needs a
    // corpus imported asks the person who set the collection up, which is the
    // same conversation they already have about permissions.
    //
    // Reading a run's record stays at `view` (`getRun`, `listRuns`): seeing
    // what an import did to a collection you are a member of is not
    // administration, and hiding it would make the record harder to trust.
    this.requireRole(actorId, input.collectionId, 'admin');

    const root = resolve(input.path.trim());
    let stat;
    try {
      stat = statSync(root);
    } catch {
      throw new CanonError('not_found', `No such export directory: ${root}`);
    }
    if (!stat.isDirectory()) {
      throw new CanonError('invalid', `Not a directory: ${root}. Unpack the export archive first.`);
    }
    // The run's own boundary, resolved once: every file read below must land
    // inside it, whatever symlinks the export directory carries.
    const realRoot = realPathOr(root);
    // CANON_IMPORT_ROOTS bounds which paths an ADMIN may aim the process at.
    // A server-managed root (the upload spool — /imports/upload) was chosen by
    // this process, not by the caller, so the admin-aiming concern the roots
    // exist for does not arise and the containment rule above still does.
    if (!opts.serverManagedRoot) {
      const permittedRoots = importRootsFromEnv();
      if (permittedRoots.length && !permittedRoots.some((permitted) => within(permitted, realRoot))) {
        throw new CanonError('forbidden', 'This deployment restricts imports to CANON_IMPORT_ROOTS', {
          path: root,
          permittedRoots,
        });
      }
    }

    const runId = input.runId?.trim() || randomUUID();
    const startedAt = now();
    const existing = this.db.prepare('SELECT * FROM import_runs WHERE id = ?').get(runId) as
      | Record<string, unknown>
      | undefined;
    if (existing) {
      if (existing.source !== source || existing.path !== root || existing.collection_id !== input.collectionId) {
        throw new CanonError('conflict', 'That run id already exists for a different source, path, or collection', {
          runId,
        });
      }
    } else {
      this.db
        .prepare(
          `INSERT INTO import_runs (id, source, path, collection_id, type, actor_id, started_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(runId, source, root, input.collectionId, type, actorId, startedAt);
    }

    const discovery = source === 'confluence' ? discoverConfluence(root) : discoverGoogleDocs(root);
    const documents = discovery.documents.slice(0, MAX_FILES_PER_RUN);
    const overflow = discovery.documents.slice(MAX_FILES_PER_RUN);

    this.audit(actor, 'import.start', {
      collectionId: input.collectionId,
      details: {
        runId,
        source,
        path: root,
        type,
        hierarchy: discovery.hierarchy,
        files: documents.length,
      },
    });

    const files: ImportFileResult[] = [];
    for (const skip of discovery.skipped) {
      files.push({
        file: skip.file,
        outcome: 'skipped',
        pageId: null,
        title: null,
        parentFile: null,
        published: false,
        reason: skip.reason,
      });
    }

    const pageByFile = new Map<string, string>();
    // Files already imported under this run id: what makes a re-run idempotent.
    for (const row of this.db.prepare('SELECT source_path, page_id FROM import_items WHERE run_id = ?').all(runId) as {
      source_path: string;
      page_id: string | null;
    }[]) {
      if (row.page_id) pageByFile.set(row.source_path, row.page_id);
    }

    for (const doc of documents) {
      const result = this.importOne(actor, {
        runId,
        source,
        root,
        realRoot,
        type,
        collectionId: input.collectionId,
        doc,
        spaceName: discovery.spaceName,
        parentPageId: doc.parentFile ? (pageByFile.get(doc.parentFile) ?? null) : null,
      });
      if (result.pageId) pageByFile.set(doc.file, result.pageId);
      files.push(result);
      this.audit(actor, 'import.page', {
        collectionId: input.collectionId,
        pageId: result.pageId ?? undefined,
        details: {
          runId,
          source,
          file: result.file,
          pageId: result.pageId,
          outcome: result.outcome,
          title: result.title,
          ...(result.reason ? { reason: result.reason } : {}),
        },
      });
    }

    for (const doc of overflow) {
      files.push({
        file: doc.file,
        outcome: 'skipped',
        pageId: null,
        title: null,
        parentFile: doc.parentFile,
        published: false,
        reason: `run file cap of ${MAX_FILES_PER_RUN} reached`,
      });
    }

    const counts = {
      found: discovery.documents.length,
      imported: files.filter((f) => f.outcome === 'imported').length,
      updated: files.filter((f) => f.outcome === 'updated').length,
      skipped: files.filter((f) => f.outcome === 'skipped').length,
      failed: files.filter((f) => f.outcome === 'failed').length,
    };
    const summary: ImportSummary = {
      runId,
      source,
      path: root,
      collectionId: input.collectionId,
      type,
      actorId,
      hierarchy: discovery.hierarchy,
      startedAt,
      finishedAt: now(),
      counts,
      files,
    };
    this.db
      .prepare('UPDATE import_runs SET finished_at = ?, summary_json = ? WHERE id = ?')
      .run(summary.finishedAt, JSON.stringify({ ...summary, files: undefined }), runId);
    this.audit(actor, 'import.finish', {
      collectionId: input.collectionId,
      details: { runId, source, path: root, counts, hierarchy: discovery.hierarchy },
    });
    return summary;
  }

  // One document: read, convert, and land it in the record. Every failure mode
  // here is contained — a bad file is reported, never fatal to the run.
  private importOne(
    actor: Actor,
    ctx: {
      runId: string;
      source: ImportSource;
      root: string;
      /** The run root with every symlink resolved; nothing may be read outside it. */
      realRoot: string;
      type: DocType;
      collectionId: string;
      doc: DiscoveredDocument;
      spaceName: string | null;
      parentPageId: string | null;
    },
  ): ImportFileResult {
    const { doc } = ctx;
    const base: ImportFileResult = {
      file: doc.file,
      outcome: 'failed',
      pageId: null,
      title: doc.indexTitle,
      parentFile: doc.parentFile,
      published: false,
      reason: null,
    };
    try {
      // Containment first, before anything is stat'd for size or read. A file
      // that resolves outside the run's root is a symlink out of the export —
      // `Onboarding.html -> /etc/passwd` — and importing it would put a file
      // the operator never chose into the record as a page.
      const real = realPathOr(doc.absPath);
      if (!within(ctx.realRoot, real)) {
        return this.record(
          ctx.runId,
          { ...base, outcome: 'skipped', reason: 'refused: this file resolves outside the export directory' },
          '',
        );
      }
      const size = statSync(doc.absPath).size;
      if (size > MAX_FILE_BYTES) {
        return this.record(ctx.runId, { ...base, outcome: 'skipped', reason: `larger than ${MAX_FILE_BYTES} bytes` }, '');
      }
      const html = readFileSync(doc.absPath, 'utf8');
      const hash = hashOf(html);
      const converted =
        ctx.source === 'confluence'
          ? convertConfluenceDocument(html, doc.file, { indexTitle: doc.indexTitle, spaceName: ctx.spaceName })
          : convertGoogleDocsDocument(html, doc.file);
      // A document that yields neither a title of its own nor any body text is
      // not a page: it is a truncated or non-HTML file. Reported, never fatal.
      if (converted.titleSource === 'filename' && !converted.body.trim()) {
        // "The file parsed to an empty document" is true and points the
        // operator at the wrong thing: the one real failure in the round-seven
        // corpus was a TRUNCATED export ending inside an unclosed comment, and
        // an operator reading "empty" goes back to the source system looking
        // for a page that is not empty. Where the tail of the file says why,
        // it says why.
        const why = truncationNote(html);
        return this.record(
          ctx.runId,
          {
            ...base,
            outcome: 'failed',
            reason: why
              ? `no readable content: ${why} — the export looks truncated, so re-export this page`
              : 'no readable content: the file parsed to an empty document',
          },
          hash,
        );
      }
      const title = converted.title || titleFromFile(doc.file);

      const prior = this.db
        .prepare('SELECT page_id, content_hash FROM import_items WHERE run_id = ? AND source_path = ?')
        .get(ctx.runId, doc.file) as { page_id: string | null; content_hash: string } | undefined;

      if (prior?.page_id) {
        // Idempotency: the same run id and the same file. Unchanged content is
        // skipped; changed content becomes a new version of the same page.
        if (prior.content_hash === hash) {
          return this.record(
            ctx.runId,
            {
              ...base,
              outcome: 'skipped',
              pageId: prior.page_id,
              title,
              reason: 'already imported by this run and unchanged',
            },
            hash,
          );
        }
        const published = this.writeBody(actor.id, prior.page_id, ctx, converted.body, title);
        return this.record(
          ctx.runId,
          { ...base, outcome: 'updated', pageId: prior.page_id, title, published, reason: 'content changed since the last run' },
          hash,
        );
      }

      const page = this.host.createPage(actor.id, {
        collectionId: ctx.collectionId,
        parentId: ctx.parentPageId,
        type: ctx.type,
        title,
      });
      const published = this.writeBody(actor.id, page.id, ctx, converted.body, title);
      return this.record(
        ctx.runId,
        {
          ...base,
          outcome: 'imported',
          pageId: page.id,
          title,
          published,
          reason: published ? null : 'body held in the draft: this type needs a named approver before it can publish',
        },
        hash,
      );
    } catch (err) {
      const message = err instanceof CanonError ? `${err.code}: ${err.message}` : (err as Error).message;
      return this.record(ctx.runId, { ...base, outcome: 'failed', reason: message }, '');
    }
  }

  // The imported body goes into the draft and is then published as a version so
  // the page is readable and searchable. Publishing always lands on status
  // 'draft' (see CanonStore.writeVersion): an import can never produce a
  // Canonical page. Types that require a named approver keep their body in the
  // draft, because Canon will not publish them without one.
  private writeBody(
    actorId: string,
    pageId: string,
    ctx: { source: ImportSource; doc: DiscoveredDocument; type: DocType },
    body: string,
    title: string,
  ): boolean {
    const rules = TYPE_RULES[ctx.type];
    const fields: PageFields = {};
    if (rules.requiresOwner) fields.ownerId = actorId;
    this.host.editDraft(actorId, pageId, { title, body, fields });
    if (rules.requiresApprover) return false;
    this.host.publish(actorId, pageId, { note: `Imported from ${ctx.source}: ${ctx.doc.file}` });
    return true;
  }

  private record(runId: string, result: ImportFileResult, hash: string): ImportFileResult {
    this.db
      .prepare(
        `INSERT INTO import_items (run_id, source_path, page_id, content_hash, outcome, reason, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (run_id, source_path) DO UPDATE SET
           page_id = excluded.page_id, content_hash = excluded.content_hash,
           outcome = excluded.outcome, reason = excluded.reason, at = excluded.at`,
      )
      .run(runId, result.file, result.pageId, hash, result.outcome, result.reason, now());
    return result;
  }

  // ---- upload ingestion (POST /imports/upload) -------------------------

  /**
   * The whole bring-your-corpus path in one call: an uploaded archive
   * unpacks into the spool and runs through the SAME importer, with the same
   * audit trail, the same draft-only arrival, and the same idempotency.
   *
   * Ordering is deliberate: role and source are checked BEFORE the archive
   * is opened, so a non-admin's upload costs no unpacking; the unpack
   * directory is keyed by run id, so a retry with the same run id lands on
   * the same recorded path and the importer's idempotency applies; and the
   * spool — archive and unpacked tree both — is removed in `finally`,
   * success or refusal, because a corpus is a thing Canon imports, not a
   * thing it quietly keeps two copies of.
   */
  runFromArchive(actorId: string, input: ImportUploadInput): ImportSummary {
    // The runId is caller-supplied AND becomes a path component of the spool
    // directory this method rm -rf's in its `finally`. Left unchecked, a
    // `runId=../../etc/cron.d` deletes an arbitrary tree on any request that
    // reaches here — including one the role check below is about to refuse,
    // because `finally` runs regardless. So it is validated to a single safe
    // segment BEFORE it touches the filesystem, and the resolved path is then
    // asserted to be a direct child of the spool — the same belt-and-braces
    // the ZIP reader uses on entry names. (The plain `run` path never uses
    // runId as a path; only this upload path does.)
    const rawRunId = input?.runId?.trim();
    if (rawRunId && !/^[A-Za-z0-9._-]{1,200}$/.test(rawRunId)) {
      throw new CanonError('invalid', 'runId may contain only letters, numbers, dot, dash and underscore');
    }
    const runId = rawRunId || randomUUID();
    const spool = importSpoolDir();
    const unpackDir = resolve(join(spool, runId));
    if (dirname(unpackDir) !== resolve(spool)) {
      // Catches `.` / `..` and anything else that escapes one level down,
      // even if the charset check above is ever loosened.
      throw new CanonError('invalid', 'runId does not resolve to a spool entry');
    }
    // One finally over EVERYTHING, refusals included: an archive the spool
    // accepted is the spool's to remove, and "we refused you AND kept your
    // corpus" is not a sentence this server gets to say.
    try {
      const source = input?.source;
      if (!source || !IMPORT_SOURCES.includes(source)) {
        throw new CanonError('invalid', `Unknown import source: ${String(source)}`, { supported: IMPORT_SOURCES });
      }
      if (!input.collectionId) throw new CanonError('invalid', 'An import requires a target collection');
      // Role BEFORE the archive opens: a non-admin's upload costs no unpacking.
      this.requireRole(actorId, input.collectionId, 'admin');
      let archive: Buffer;
      try {
        archive = readFileSync(input.archivePath);
      } catch {
        throw new CanonError('invalid', 'The uploaded archive could not be read back from the spool');
      }
      rmSync(unpackDir, { recursive: true, force: true });
      mkdirSync(unpackDir, { recursive: true });
      try {
        extractZip(archive, unpackDir);
      } catch (err) {
        // Whatever was half-written is not an export; nothing downstream may
        // mistake it for one.
        rmSync(unpackDir, { recursive: true, force: true });
        throw err;
      }
      // Export tools usually wrap everything in one top-level folder (the
      // space or drive name). The importer wants the folder the documents
      // live in, so a lone wrapping directory is entered rather than making
      // every upload fail with "no documents found".
      let root = unpackDir;
      const top = readdirSync(root, { withFileTypes: true }).filter((e) => e.name !== '__MACOSX');
      if (top.length === 1 && top[0]!.isDirectory()) root = join(root, top[0]!.name);

      return this.run(
        actorId,
        { source, path: root, collectionId: input.collectionId, type: input.type, runId },
        { serverManagedRoot: true },
      );
    } finally {
      rmSync(unpackDir, { recursive: true, force: true });
      rmSync(input.archivePath, { force: true });
    }
  }

  // ---- run records -----------------------------------------------------

  getRun(actorId: string, runId: string): ImportRunRecord {
    const row = this.db.prepare('SELECT * FROM import_runs WHERE id = ?').get(runId) as
      | Record<string, unknown>
      | undefined;
    const notFound = new CanonError('not_found', `No such import run: ${runId}`);
    if (!row) throw notFound;
    // Existence before permission is an oracle, and this is the one id space in
    // Canon where it is worth closing (SECURITY.md R4). Every other identifier
    // — page, collection, version, comment, source, saved query — is a random
    // UUID, so a 403 there confirms an id somebody already had. A RUN ID IS
    // CALLER-SUPPLIED (see `ImportInput.runId`, which exists so an interrupted
    // migration can be resumed), so it is whatever an operator typed:
    // `confluence-2026-07`, `migration-1`. That is a guessable namespace, and
    // a guessable namespace with a distinguishable refusal is enumerable.
    // A run whose collection the caller holds no role in therefore reads
    // exactly as a run that does not exist — the same code, the same message —
    // which is also what `listRuns` already says by omitting it.
    //
    // A caller who IS a member and simply lacks `view` cannot happen (`view`
    // is the lowest role), so nothing legitimate loses its explanatory 403.
    if (!this.host.roleOf(actorId, row.collection_id as string)) throw notFound;
    this.requireRole(actorId, row.collection_id as string, 'view');
    const items = this.db
      .prepare('SELECT * FROM import_items WHERE run_id = ? ORDER BY at, source_path')
      .all(runId) as Record<string, unknown>[];
    const summary = JSON.parse((row.summary_json as string) || '{}') as Partial<ImportSummary>;
    return {
      runId: row.id as string,
      source: row.source as ImportSource,
      path: row.path as string,
      collectionId: row.collection_id as string,
      type: row.type as DocType,
      actorId: row.actor_id as string,
      hierarchy: summary.hierarchy ?? 'flat',
      startedAt: row.started_at as string,
      finishedAt: (row.finished_at as string) ?? '',
      counts: summary.counts ?? { found: 0, imported: 0, updated: 0, skipped: 0, failed: 0 },
      files: [],
      items: items.map((item) => ({
        file: item.source_path as string,
        pageId: (item.page_id as string) ?? null,
        outcome: item.outcome as ImportOutcome,
        reason: (item.reason as string) ?? null,
        at: item.at as string,
      })),
    };
  }

  listRuns(actorId: string): Omit<ImportRunRecord, 'items' | 'files'>[] {
    this.host.getActor(actorId);
    const rows = this.db
      .prepare(
        `SELECT r.* FROM import_runs r
         JOIN collection_members m ON m.collection_id = r.collection_id
         WHERE m.actor_id = ? ORDER BY r.started_at DESC`,
      )
      .all(actorId) as Record<string, unknown>[];
    return rows.map((row) => {
      const summary = JSON.parse((row.summary_json as string) || '{}') as Partial<ImportSummary>;
      return {
        runId: row.id as string,
        source: row.source as ImportSource,
        path: row.path as string,
        collectionId: row.collection_id as string,
        type: row.type as DocType,
        actorId: row.actor_id as string,
        hierarchy: summary.hierarchy ?? 'flat',
        startedAt: row.started_at as string,
        finishedAt: (row.finished_at as string) ?? '',
        counts: summary.counts ?? { found: 0, imported: 0, updated: 0, skipped: 0, failed: 0 },
      };
    });
  }

  // ---- internals -------------------------------------------------------

  private requireRole(actorId: string, collectionId: string, needed: Role): void {
    const role = this.host.roleOf(actorId, collectionId);
    if (!role || ROLE_RANK[role] < ROLE_RANK[needed]) {
      // One sentence, built in abilities.ts, and the same one the screen shows
      // before the click (USER-TESTING.md T4.4, second round).
      throw forbiddenRole(this.db, collectionId, role, needed);
    }
  }

  private audit(
    actor: Actor,
    action: string,
    ctx: { collectionId?: string; pageId?: string; details?: Record<string, unknown> } = {},
  ): void {
    this.db
      .prepare(
        `INSERT INTO audit_events (at, actor_id, actor_kind, action, collection_id, page_id, details_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        now(),
        actor.id,
        actor.kind,
        action,
        ctx.collectionId ?? null,
        ctx.pageId ?? null,
        JSON.stringify(ctx.details ?? {}),
      );
  }
}
