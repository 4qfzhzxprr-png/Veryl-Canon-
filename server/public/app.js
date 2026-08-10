// Veryl Canon web UI — a single-file, no-dependency SPA over the Canon API.
// Identity is whichever door the server has open, learned from GET
// /auth/session at start-up: a real SSO sign-in when one is configured, and
// the dev X-Actor-Id picker when CANON_DEV_AUTH=true. A cookie session carries
// its CSRF token on every write (see api()). Hash routing; all rendering
// through esc() so no record content is ever injected as HTML.

'use strict';

// ---------------------------------------------------------------------------
// Constants mirrored from the server's document-type table. These describe
// form shape only (which fields a type carries); permissions and workflow
// legality stay server-side and surface here through API error codes.

const TYPE_LABELS = { policy: 'Policy', spec: 'Spec', plan: 'Plan', note: 'Note' };
const TYPE_HELP = {
  policy: 'Official rules. Needs an owner and a named approver; carries an effective date.',
  spec: 'How something is built or must behave. Needs an owner and a named approver.',
  plan: 'What will be done and when. Needs an owner.',
  note: 'Working material. Publishes directly and never carries the Canonical mark.',
};
// Mirrors TYPE_RULES in src/model.ts. `reviewDate` is which types may CARRY
// one; a Policy also requires one before it can publish, which the server
// enforces and the editor labels.
const TYPE_FIELDS = {
  policy: { owner: true, approver: true, effectiveDate: true, reviewDate: true, reviewDateRequired: true },
  spec: { owner: true, approver: true, effectiveDate: false, reviewDate: true },
  plan: { owner: true, approver: false, effectiveDate: false, reviewDate: true },
  note: { owner: false, approver: false, effectiveDate: false, reviewDate: false },
};
const REVIEWED_TYPES = ['policy', 'spec', 'plan'];

// Canon's own actor (src/system.ts). Mirrored here as a constant rather than
// looked up, because it is deliberately NOT in the actor directory: it is not
// somebody you can name as an owner or an approver, so `GET /actors` does not
// carry it and `actorName` would render a truncated id for the one actor whose
// name matters most in an audit log — the one that says a machine did this.
const SYSTEM_ACTOR_ID = 'system:canon';
const SYSTEM_ACTOR_NAME = 'Canon';

const STATUS_LABELS = {
  draft: 'Draft',
  in_review: 'In Review',
  canonical: 'Canonical',
  // Freshness (FEATURES.md §3): a Canonical page whose review date has passed.
  // It is still the official record, so it reads as a flag on the page rather
  // than a demotion to a working note.
  needs_update: 'Needs Update',
  archived: 'Archived',
};

// WHAT EACH BADGE MEANS, IN THE ONE SENTENCE A READER NEEDS.
//
// Needs Update was the only status in the product a new contributor could
// learn from the interface — "the only status that explains itself, and it
// does it beautifully" (USER-TESTING.md T4.7) — and it managed that because
// its two words say what to do about it. Canonical, Draft, In Review and
// Archived said nothing: no key, no glossary, nothing that told her which
// badge meant "safe to read to a customer".
//
// So every status now answers the same question Needs Update answers, in the
// same voice, and the answer is about RELIANCE rather than about workflow: may
// a reader act on this page, or not, and why. One sentence each, written once
// and rendered wherever badges are — the key on a collection's front page, the
// key in the map legend, and the description carried by every badge in the
// product (see `badge` below). Not four tooltips: one sentence, in four
// places, saying the same thing each time.
const STATUS_MEANINGS = {
  draft: 'Working material. Nobody has approved it and it is not the record — do not act on it or quote it to a member.',
  in_review: 'Written and submitted, waiting on its named approver. What it says is proposed, not agreed.',
  canonical: 'Approved by its named approver, and inside the review date they set. This is the official record: you may rely on it and quote it.',
  needs_update: 'Approved, but past the review date its owner set. It is still the official record and nothing has replaced it — nobody has confirmed it recently.',
  archived: 'Taken out of the record and kept for its history. It is not the answer to anything now.',
};

const ROLES = ['view', 'comment', 'edit', 'approve', 'admin'];

// Mirrors NotificationKind in src/notify.ts. The outbox has been written to
// since notifications shipped and nothing in this UI ever read it (USER-TESTING
// T2.1); the queue renders it, and a row needs a word for what it is. An
// unknown kind falls through to its own code rather than to "notification",
// because a name we have not learned yet is still more informative than none.
const NOTIFICATION_LABELS = {
  mention: 'Mentioned',
  review_requested: 'Review requested',
  draft_approved: 'Approved',
  draft_sent_back: 'Sent back',
  review_withdrawn: 'Withdrawn',
  proposal_opened: 'Proposal',
  proposal_accepted: 'Proposal accepted',
  proposal_rejected: 'Proposal rejected',
  proposal_superseded: 'Proposal superseded',
  review_due: 'Review due',
  divergence_opened: 'Sources disagree',
  access_requested: 'Access requested',
  access_decided: 'Access decision',
};

// ---------------------------------------------------------------------------
// State

const state = {
  actor: readStoredActor(),
  // GET /auth/session: { mode, sso, devAuth, authenticated, actor, csrfToken,
  // csrfHeader, loginUrl }. Which door is open is the server's answer, not a
  // build-time constant, so one UI serves an SSO deployment and a dev one.
  auth: null,
  actors: null, // cached GET /actors
  // null = not yet probed
  features: {
    search: null, comments: null, ask: null, related: null, references: null, sources: null,
    // The knowledge map, and separately the whole-record map: two endpoints,
    // two probes. See detectMap / detectWholeGraph.
    map: null, wholeGraph: null,
    // Whether review dates do anything on THIS deployment (GET
    // /maintenance/freshness). Not a capability probe like the rest: the route
    // is always there, and what it answers is whether the timer is running,
    // how often, whom the flips are attributed to, and how far an owner's
    // notice travels. The editor used to promise a flip and a notification
    // flatly; on a deployment where neither happened, that was the product
    // lying to the one person who could have done something about it.
    freshness: null,
    // Attestation and export (FEATURES.md §7). One probe covers the whole
    // family — as-of, the page bundle, the collection register — because they
    // ship together. See detectAttestation.
    attestation: null,
    // What happens when the record disagrees with itself (DATA-BACKBONE.md §7).
    // THREE independent probes, because they are three separate pieces of
    // server: the asserted relation between two pages, the divergence a
    // corroborating source raised against its authority, and — read straight
    // off the answer payload rather than probed — a disagreement between two
    // Canonical passages. A Canon that serves one and not the others shows
    // exactly the one it serves.
    relations: null, divergences: null, gaps: null,
    // The queue (GET /queue). Not probed on its own: the first load of the nav
    // badge answers the question, and a 404 hides the entry.
    queue: null,
    // Imports (GET /imports). Probed like sources, and then narrowed by what
    // this reader has to do with them — see detectImports.
    imports: null,
  },
  afterIdentity: null, // hash to return to after picking an identity
  ask: null, // last { question, collectionId, result } so back-navigation keeps it
  sourcesById: null, // cached GET /sources, keyed by id, for reference provenance
  // The queue (GET /queue, USER-TESTING.md T2.1). `data` is the last answer,
  // `at` when it arrived: the nav badge and the view share one fetch rather
  // than each asking, and a stale badge is refreshed on navigation.
  queue: { data: null, at: 0, loading: null },
  // The summary the last run in THIS tab returned. The stored run record keeps
  // a file, a page and an outcome per file and no title, so this is the only
  // place a page's title can come from on the run screen — and it is never
  // stood in for: a run somebody else made, or one from before this page was
  // loaded, shows the file names the record actually holds.
  lastImport: null,
};

function resetFeatures() {
  state.features = {
    search: null, comments: null, ask: null, related: null, references: null, sources: null,
    map: null, wholeGraph: null, attestation: null,
    relations: null, divergences: null, queue: null, gaps: null, imports: null,
  };
  gapsProbe = null;
  importsProbe = null;
  state.lastImport = null;
  askProbe = null;
  sourcesProbe = null;
  attestationProbe = null;
  mapProbe = null;
  wholeGraphProbe = null;
  wholeGraphCache = null;
  state.map = null;
  state.sourcesById = null;
  // Whose queue it was is part of what was cached, so signing out drops it.
  state.queue = { data: null, at: 0, loading: null };
  const count = document.getElementById('nav-queue-count');
  if (count) count.hidden = true;
}

function readStoredActor() {
  try {
    const raw = localStorage.getItem('canon.actor');
    const a = raw ? JSON.parse(raw) : null;
    return a && a.id ? a : null;
  } catch {
    return null;
  }
}

function storeActor(actor) {
  state.actor = actor;
  if (actor) localStorage.setItem('canon.actor', JSON.stringify(actor));
  else localStorage.removeItem('canon.actor');
}

// ---------------------------------------------------------------------------
// API client — every call carries X-Actor-Id; errors throw {status, code,
// message, details} built from the server's error payload.

async function api(method, path, body, opts = {}) {
  const headers = {};
  // A cookie session is ambient, so it identifies the caller on its own and
  // must never travel alongside an X-Actor-Id: the server refuses the pair.
  const cookieSession = state.auth?.viaCookie === true;
  const actorId = cookieSession ? null : (opts.actorId ?? state.actor?.id);
  if (actorId) headers['X-Actor-Id'] = actorId;
  // The CSRF token for a cookie-authenticated write. Safe methods do not need
  // it and header-identified requests are not ambient, so neither carries one.
  if (cookieSession && state.auth?.csrfToken && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    headers[state.auth.csrfHeader ?? 'X-Canon-CSRF'] = state.auth.csrfToken;
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw { status: 0, code: 'network', message: 'Cannot reach the Canon server.', details: {} };
  }
  // Any write may have changed what is waiting on this person — approving,
  // sending back, submitting, publishing, closing a divergence, being granted
  // or losing a membership. Rather than remembering to invalidate the queue at
  // each of those call sites and forgetting one, the cached queue is dropped
  // after every request that was not a read, and the next navigation asks
  // again. Read-only methods keep it, which is what makes the badge cheap.
  if (res.ok && !['GET', 'HEAD', 'OPTIONS'].includes(method) && path !== '/queue') {
    state.queue.at = 0;
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) {
    throw {
      status: res.status,
      code: data?.error ?? 'error',
      message: data?.message ?? `Request failed (${res.status})`,
      details: data ?? {},
    };
  }
  return data;
}

// Which door is open, and who (if anyone) is already through it. Called once
// at start-up and again after a sign-out.
async function loadAuth() {
  try {
    state.auth = await api('GET', '/auth/session');
  } catch {
    // An older server with no /auth/session: dev mode, as it always was.
    state.auth = { mode: 'dev', sso: false, devAuth: true, authenticated: false, actor: null, csrfToken: null };
  }
  if (state.auth.authenticated && state.auth.actor) storeActor(state.auth.actor);
  else if (state.auth.viaCookie === false && state.auth.devAuth === false) storeActor(null);
  return state.auth;
}

async function loadActors(force = false) {
  if (!state.actors || force) {
    // The directory is narrowed to people you actually work with, so it is
    // only fetchable as somebody. Before sign-in, the dev picker has its own
    // door; with SSO there is nothing to pick.
    state.actors = state.actor || state.auth?.viaCookie
      ? await api('GET', '/actors')
      : state.auth?.devAuth
        ? await api('GET', '/auth/dev/actors')
        : [];
  }
  return state.actors;
}

function actorById(id) {
  return (state.actors ?? []).find((a) => a.id === id) ?? null;
}

function actorName(id) {
  if (!id) return '—';
  if (id === SYSTEM_ACTOR_ID) return SYSTEM_ACTOR_NAME;
  const a = actorById(id);
  return a ? a.name : id.slice(0, 8) + '…';
}

function isSystemActor(id) {
  return id === SYSTEM_ACTOR_ID;
}

// ---------------------------------------------------------------------------
// Small helpers

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * A search snippet, which is the one string the server sends with markup in
 * it: SQLite's FTS5 `snippet()` wraps each matched term in `<mark>…</mark>`.
 * Escaping the whole thing printed those tags as literal text in every result
 * — "…<mark>unreadable</mark> <mark>member</mark> id…" — which is what a
 * contributor saw on the screen she touches most.
 *
 * The bug is older than it looks: it was reachable only once search started
 * returning matches for the things people actually type, so it went unseen
 * while search was the weaker half of the product.
 *
 * Everything is still escaped. The string is SPLIT on the two tags the server
 * is known to emit, every piece between them is escaped as text, and only the
 * tags themselves are re-emitted as markup — so a page whose body genuinely
 * contains `<script>` is inert here, exactly as before.
 */
function highlightedSnippet(snippet) {
  return String(snippet ?? '')
    .split(/(<\/?mark>)/)
    .map((part) => (part === '<mark>' || part === '</mark>' ? part : esc(part)))
    .join('');
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return esc(iso);
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// The same instant, to the second. The audit log needs it and nothing else
// does: a seeded record writes 1,100 events inside one minute, and a table of
// them displayed to the minute shows a column of identical timestamps beside
// rows whose ORDER is the only thing distinguishing them. An auditor
// reconstructing a sequence — submitted, then approved, then viewed — cannot
// do it from a display that has thrown the ordering away.
function fmtInstant(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return esc(iso);
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso + (iso.length === 10 ? 'T00:00:00' : ''));
  if (Number.isNaN(d.getTime())) return esc(iso);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

// How long ago something happened, in words. Used wherever an age is the
// point — a federated value's age is part of how much it can be trusted.
function fmtAgo(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 45) return 'moments ago';
  const units = [
    ['minute', 60], ['hour', 3600], ['day', 86400], ['month', 2592000], ['year', 31536000],
  ];
  let label = 'minute', size = 60;
  for (const [name, secs] of units) {
    if (s >= secs) { label = name; size = secs; }
  }
  const n = Math.round(s / size);
  return `${n} ${label}${n === 1 ? '' : 's'} ago`;
}

// A duration in plain words: freshness windows arrive as milliseconds and
// nobody reasons in milliseconds.
function fmtDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '—';
  const units = [['day', 86400000], ['hour', 3600000], ['minute', 60000], ['second', 1000]];
  for (const [name, size] of units) {
    if (n >= size && n % size === 0) { const v = n / size; return `${v} ${name}${v === 1 ? '' : 's'}`; }
  }
  for (const [name, size] of units) {
    if (n >= size) { const v = Math.round((n / size) * 10) / 10; return `${v} ${name}${v === 1 ? '' : 's'}`; }
  }
  return `${n} ms`;
}

// selector/key strings come from configuration, not prose: make them read as
// field names without pretending to know more than we do.
function humanizeKey(s) {
  const raw = String(s ?? '').trim();
  if (!raw) return 'Value';
  const words = raw
    .replace(/[_.\-/]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// Every badge carries its own meaning. `title` is the hover, and it is NOT the
// glossary — a sentence nobody can find is not a glossary — it is the same
// sentence the key states in full, attached to the thing it is about so that
// the badge is never encountered stripped of it. The key is `statusKeyHTML`,
// and it is on screen, unfolded, where the badges first appear.
function badge(status, size = '') {
  const label = STATUS_LABELS[status] ?? status;
  const meaning = STATUS_MEANINGS[status];
  const title = meaning ? ` title="${esc(`${label} — ${meaning}`)}"` : '';
  return `<span class="badge badge-${esc(status)} ${size}"${title}>${esc(label)}</span>`;
}

// A page has TWO standings at once while a marked page is being edited: its own
// last Canonical (or Needs Update) standing — what a reader may rely on right
// now, and what Ask still draws on — and its DRAFT's, which is In Review.
// Submitting a revision overwrites `status` with the draft's, so a plain
// `badge(page.status)` reads a Canonical page with a pending edit as unreviewed.
// The server carries the page's own standing separately in `pageStanding` (set
// only while a revision is in review over a still-marked version); where it is
// present, show it, with the revision noted BESIDE it rather than in place of
// it — "Canonical · revision in review". Everywhere else this is just `badge`.
function pageBadge(page, size = '') {
  const standing = page && page.pageStanding;
  if (!standing) return badge(page && page.status, size);
  const note = `A revision of this page is in review; its ${STATUS_LABELS[standing] ?? standing} version is ` +
    'still the record’s own answer until the revision is approved.';
  return `${badge(standing, size)}<span class="revision-note ${esc(size)}" title="${esc(note)}"> · revision in review</span>`;
}

/**
 * The key. One row per status, each saying whether a reader may rely on the
 * page — the treatment Needs Update already got, given to the other four.
 *
 * `present` narrows it to the statuses actually on the screen it sits under,
 * because a key to things that are not there is furniture. Passing nothing
 * gives the whole set, which is what the map legend wants.
 */
function statusKeyHTML(present = null) {
  const order = ['canonical', 'needs_update', 'in_review', 'draft', 'archived'];
  const shown = present ? order.filter((s) => present.has(s)) : order;
  if (!shown.length) return '';
  return `
    <dl class="status-key">
      ${shown.map((s) => `
        <div class="status-key-row">
          <dt>${badge(s, 'sm')}</dt>
          <dd>${esc(STATUS_MEANINGS[s])}</dd>
        </div>`).join('')}
    </dl>`;
}

// Three kinds now, and the third is the point: work Canon does on its own clock
// is tagged `system` wherever an actor is rendered, so nobody reading a page or
// an audit row can mistake it for a colleague's act.
function kindTag(kind) {
  if (kind === 'agent') return '<span class="kind-tag agent">agent</span>';
  if (kind === 'system') return '<span class="kind-tag system">system</span>';
  return '<span class="kind-tag">person</span>';
}

// The `restricted` chip, and what it is allowed to claim.
//
// It used to say "Views are logged to the audit log" on two of its three
// renderings and nothing at all on the third. Beside a word as loaded as
// "restricted" that reads as an aside to the real point — and the real point
// was untrue: `restricted` is read by no permission check anywhere in the
// server. Membership decides who may open a collection, restricted or not
// (round seven, tester 47, who proved it against two collections). So the chip
// says the two things the flag DOES do, and says the thing it does not.
function restrictedTagHTML() {
  return `<span class="restricted-tag" title="Reads of these pages are recorded in the audit log, refusals included, and they are kept from any outside AI service. Who may open the collection is decided by its members, here as everywhere.">restricted</span>`;
}

function actorLabel(id) {
  if (isSystemActor(id)) return `${esc(SYSTEM_ACTOR_NAME)} ${kindTag('system')}`;
  const a = actorById(id);
  if (!a) return esc(actorName(id));
  return `${esc(a.name)}${a.kind === 'agent' ? ' <span class="kind-tag agent">agent</span>' : ''}`;
}

// ---------------------------------------------------------------------------
// Toasts
//
// A TOAST IS FOR NEWS, NEVER FOR A REFUSAL THAT VANISHES.
//
// The second round of user testing found the product saying no in two voices,
// and the worse one was this: a red toast in the bottom-right corner, behind a
// dimmed modal backdrop, gone in about three seconds. A contributor pressed a
// solid green "Assert it", nothing happened, the dialog stayed open, and the
// only explanation had already left the screen — "if I had blinked, I would
// have gone home believing I had raised mine."
//
// Two things follow, and they are the whole of the fix here. A refusal that
// arrives after a click STAYS until it is dismissed, because a message with a
// three-second life is not a message. And a refusal raised inside a dialog is
// drawn IN the dialog (see `openModal`), because a message behind the backdrop
// is not on the reader's screen at all.
function toast(message, kind = 'error') {
  const host = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  const text = document.createElement('span');
  text.textContent = message;
  el.appendChild(text);
  const leave = () => { el.classList.add('leaving'); setTimeout(() => el.remove(), 300); };
  // Good news passes; a refusal waits to be read — and so does a WARNING, which
  // is the third kind and the reason this is no longer a two-way split. "You
  // published, and eleven of your fourteen readers cannot follow a link in
  // it" is not good news and it is not a refusal: the act happened, and the
  // sentence is the only thing that will make the author go back and look. A
  // two-and-a-half-second life would put it on screen while its reader was
  // already three actions further on.
  if (kind === 'error' || kind === 'warn') {
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    close.addEventListener('click', leave);
    el.appendChild(close);
    el.setAttribute('role', 'alert');
  } else {
    // Short on purpose: good news is one glance. At four and a half seconds
    // the "Published." toast was still on screen while its reader was three
    // actions further on (fourth round, Priya); a refusal above still waits
    // to be dismissed, because those two lifetimes serve different sentences.
    setTimeout(leave, 2500);
  }
  host.appendChild(el);
}

function toastError(err) {
  toast(err?.message ?? 'Something went wrong.', 'error');
}

// ---------------------------------------------------------------------------
// Refusal — one vocabulary, everywhere (USER-TESTING.md T4.4, second round)
//
// The server writes the sentence: what the act needs, what the caller holds,
// and who can. `abilities.ts` builds it once so a page, a collection and a
// source all refuse in the same words, and the client's whole job is to put it
// somewhere a person will actually read it. That is this section, and every
// screen that greys a control uses it — the page view, Members, the source
// register, and the relation dialog.
//
// WHY A REFUSED CONTROL IS NOT `disabled`
//
// A `disabled` button cannot be focused, cannot be tapped, and announces
// nothing; its `title` is invisible to a keyboard and to a phone, which is why
// the reason is written out as text as well. `aria-disabled` says the same
// thing to assistive technology while leaving the control reachable, so tabbing
// to it or tapping it is how somebody finds out why — and nothing is wired to
// it, so pressing it does exactly what the server would have done: nothing.
//
// AND WHY THE REASONS DO NOT STACK
//
// Two greyed buttons used to produce two near-identical grey sentences under
// the page title, differing only in the first word: "three or four of these and
// there's a paragraph of apology above the thing I opened the page to read."
// So: one refusal is one line, as it always was. Two or more collapse to a
// single line with a "Why?" that opens them — and focusing, hovering or tapping
// any greyed control opens the list and lights that control's own reason. The
// text is never merely a tooltip; it is always in the document, one keystroke
// or one tap away.

let refusalSeq = 0;

/** "Two", "Three" — a count that reads as prose up to the point it stops being one. */
function countWord(n) {
  return ['no', 'one', 'Two', 'Three', 'Four', 'Five', 'Six'][n] ?? String(n);
}

/**
 * A group of controls that share one refusal note. `offer` returns the enabled
 * HTML or a greyed control carrying the server's sentence; `noteHTML` returns
 * the note to place under them; `wire` connects the two.
 */
function refusalGroup(what = 'these') {
  const seq = ++refusalSeq;
  const reasons = []; // { id, why }, deduplicated: one sentence, one line
  let refused = 0; // CONTROLS refused, which is what the summary counts
  const idFor = (why) => {
    refused += 1;
    const found = reasons.find((r) => r.why === why);
    if (found) return found.id;
    const id = `refusal-${seq}-${reasons.length + 1}`;
    reasons.push({ id, why });
    return id;
  };
  return {
    get count() { return refused; },
    /** A control the server would refuse, whatever the caller was about to press. */
    refuse(label, why, { className = 'btn' } = {}) {
      const id = idFor(why ?? 'You cannot do this here.');
      return `<button type="button" class="${className} is-refused" aria-disabled="true"
        data-refusal="${esc(id)}" aria-describedby="${esc(id)}"
        title="${esc(why ?? '')}">${label}</button>`;
    },
    /** `ability` is the server's `{ can, why }`; anything absent is treated as permitted. */
    offer(ability, label, enabledHTML, opts) {
      if (!ability || ability.can !== false) return enabledHTML;
      return this.refuse(label, ability.why, opts);
    },
    /**
     * The reasons, as one line or as a line that opens onto them. The count is
     * of CONTROLS — what the reader can see is greyed — while the list holds
     * one line per distinct sentence: eight pages refused for the same two
     * reasons are eight greyed rows and two lines, not eight.
     */
    noteHTML({ collapse = false, summary = null } = {}) {
      if (!refused) return '';
      if (refused === 1 && !collapse) {
        const only = reasons[0];
        return `<p class="muted refusal-note" id="${esc(only.id)}">${esc(only.why)}</p>`;
      }
      const listId = `refusal-list-${seq}`;
      return `
        <div class="refusal-note refusal-many">
          <p class="muted refusal-summary">${esc(summary ?? `${countWord(refused)} of ${what} are greyed out.`)}
            <button type="button" class="linkish" data-refusal-toggle
              aria-expanded="false" aria-controls="${listId}">Why?</button></p>
          <ul class="muted refusal-list" id="${listId}" hidden>
            ${reasons.map((r) => `<li id="${esc(r.id)}">${esc(r.why)}</li>`).join('')}
          </ul>
        </div>`;
    },
  };
}

// ---------------------------------------------------------------------------
// Modal — one at a time; onSubmit(form) may throw/reject to keep it open.
//
// A refusal raised in here is drawn IN here. It used to go to a toast in the
// far corner, behind this dialog's own backdrop, and disappear — which is how a
// contributor came to believe she had asserted a conflict she had not.
//
// It said `aria-modal="true"` and behaved like nothing of the kind (round
// seven): Tab walked straight out of the dialog into the page behind it, which
// a screen reader has been told is not there; Escape did nothing, so the one
// key everybody tries to dismiss a dialog with left them hunting for Cancel;
// and closing it dropped focus on the body, so the next Tab started again from
// the top of the document — 85 stops from where they had been working.
//
// Deliberately NOT a `<dialog>` element with showModal(), which would give all
// three for free. The dialog is rendered as a string into #modal-root like
// everything else in this client, several callers reach into `#modal-root form`
// afterwards to wire their own fields, and `<dialog>`'s top-layer rendering
// changes how the backdrop and the sticky header stack. Three real behaviours
// are worth more than the elegance of a rewrite that touches nine call sites.

/** What can hold focus inside a dialog. `:not([disabled])` matters: the submit
 *  button disables itself while a save is in flight, and a trap that cycled
 *  onto it would strand the reader on a control that does nothing. */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function openModal({ title, body, submitLabel = 'Save', cancelLabel = 'Cancel', danger = false, onSubmit }) {
  const root = document.getElementById('modal-root');
  // Whoever opened it. Focus goes back here when it closes — the button that
  // opened a dialog is where the reader was, and it is where the next thing
  // they do begins.
  const opener = document.activeElement;
  root.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <h2>${esc(title)}</h2>
        <form>
          ${body}
          <p class="modal-refusal" data-modal-error role="alert" hidden></p>
          <div class="modal-actions">
            <button type="button" class="btn" data-cancel>${esc(cancelLabel)}</button>
            <button type="submit" class="btn ${danger ? 'danger' : 'primary'}">${esc(submitLabel)}</button>
          </div>
        </form>
      </div>
    </div>`;
  const backdrop = root.querySelector('.modal-backdrop');
  const form = root.querySelector('form');
  const problem = form.querySelector('[data-modal-error]');
  const dialog = root.querySelector('.modal');
  const close = () => {
    document.removeEventListener('keydown', onKeydown, true);
    root.innerHTML = '';
    // Only if the opener is still in the document: a dialog whose submit
    // re-rendered the view behind it has no opener left to go back to, and
    // focusing a detached node silently focuses the body instead. The route's
    // own focus move (announceRoute) covers that case.
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
  };
  // Capture phase, on the document: the dialog's own fields stop keys from
  // reaching a listener bound to the dialog (the editor's textarea handles
  // Tab itself), and a trap that can be escaped by one field is not a trap.
  const onKeydown = (e) => {
    if (e.key === 'Escape') {
      // Escape closes without acting. That is the whole contract: it is the
      // "I did not mean to open this" key, and a dialog that submits on it
      // would be a destructive act triggered by a reflex.
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    const stops = [...dialog.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (!stops.length) { e.preventDefault(); return; }
    const first = stops[0];
    const last = stops[stops.length - 1];
    const active = document.activeElement;
    if (!dialog.contains(active)) {
      // Focus got out some other way (a click on the page behind, an
      // extension). Bring it back rather than letting the cycle continue
      // outside a dialog that claims to be modal.
      e.preventDefault();
      first.focus();
      return;
    }
    if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', onKeydown, true);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  root.querySelector('[data-cancel]').addEventListener('click', close);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = form.querySelector('button[type=submit]');
    submitBtn.disabled = true;
    problem.hidden = true;
    try {
      await onSubmit(form);
      close();
    } catch (err) {
      submitBtn.disabled = false;
      // In the dialog, and it stays there. The dialog is still open because the
      // act did not happen, and this is the sentence that says why.
      problem.textContent = err?.message ?? 'Something went wrong.';
      problem.hidden = false;
      problem.scrollIntoView({ block: 'nearest' });
    }
  });
  // The first field if there is one, otherwise the first control of any kind:
  // a confirm dialog is all buttons, and it used to open with focus still on
  // the page behind it — which is a dialog you cannot answer from the keyboard
  // without tabbing through the whole document to find it.
  const first = form.querySelector('input, textarea, select') ?? dialog.querySelector(FOCUSABLE);
  if (first) first.focus();
  else { dialog.setAttribute('tabindex', '-1'); dialog.focus(); }
  return { close, form, showRefusal: (message) => { problem.textContent = message; problem.hidden = false; } };
}

// ---------------------------------------------------------------------------
// Markdown — a deliberately small, safe subset. Everything is HTML-escaped
// first; only markup this renderer generates ever reaches the DOM.
//
// TABLES ARE PART OF THE SUBSET, and they have to be. The corpus Canon is for
// — retention schedules, coverage criteria, plan comparisons — is
// substantially tabular, and a renderer that shows a retention schedule as
// `| Region | Owner | | --- | --- |` is not showing the record at all
// (USER-TESTING.md T4.1, a hard stop for the one writer who was not an
// engineer). GitHub-flavoured pipe tables are the syntax to support because
// they are what everything else emits: what src/html.ts writes out of a
// Confluence or Google Docs import, what a paste from another Markdown tool
// carries, and what the editor's own Table button inserts.
//
// The grammar below is not all of GFM and is not trying to be. Every deviation
// is in one direction — never silently drop what somebody wrote:
//
//   * A ragged row keeps its cells. GFM truncates a row longer than the header
//     and pads a shorter one; truncating deletes content from a record, so the
//     table is widened to its widest row instead and every cell survives. A
//     column with no header cell simply has an empty header.
//   * `\|` inside a cell is an escaped pipe, not a column break. This is the
//     one backslash escape the subset has, and it exists because html.ts emits
//     it: a Confluence cell reading "Retain 7 | 10 years" must not silently
//     become two columns on the way in.
//
// What is deliberately still out: inline HTML, images, footnotes, setext
// headings, and pipes inside a code span (`a | b` in a cell splits the cell —
// write `a \| b`).

function renderMarkdown(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // closing fence (or EOF)
      out.push(`<pre class="codeblock"><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${mdInline(heading[2])}</h${level}>`);
      i++;
      continue;
    }
    // A thematic break before the list check: `- - -` and `* * *` are rules,
    // not one-item lists. An imported page footer arrives as an <hr> and the
    // text under it (html.ts writes the rule as `---`), and rendering the rule
    // as the literal characters made the footer read as another paragraph of
    // the policy — which is how a "Confidential — internal use only" line ends
    // up looking like a clause (USER-TESTING.md T4.1, second half).
    if (isThematicBreak(line)) { out.push('<hr>'); i++; continue; }
    if (isTableStart(lines, i)) {
      const table = parseTable(lines, i);
      out.push(table.html);
      i = table.next;
      continue;
    }
    if (matchListItem(line)) {
      const list = parseList(lines, i, matchListItem(line).indent);
      out.push(list.html);
      i = list.next;
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(mdInline(lines[i].replace(/^\s*>\s?/, '')));
        i++;
      }
      out.push(`<blockquote>${buf.join('<br>')}</blockquote>`);
      continue;
    }
    if (isMdBlank(line)) { i++; continue; }
    const buf = [];
    while (i < lines.length && !isMdBlank(lines[i]) && !startsMdBlock(lines, i)) {
      buf.push(mdInline(lines[i]));
      i++;
    }
    out.push(`<p>${buf.join(' ')}</p>`);
  }
  return out.join('\n');
}

function isMdBlank(line) {
  return /^\s*$/.test(line ?? '');
}

// What ends a paragraph. A table has to be in here as well as in the block
// loop: a schedule written directly under its sentence, with no blank line
// between, is the normal way people write one, and without this the header row
// is swallowed into the paragraph and the rest of the table renders headless.
function startsMdBlock(lines, i) {
  const line = lines[i];
  return /^(#{1,6}\s|```|\s*>)/.test(line) ||
    isThematicBreak(line) ||
    matchListItem(line) !== null ||
    isTableStart(lines, i);
}

function isThematicBreak(line) {
  return /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line ?? '');
}

// ---------------------------------------------------------------------------
// Lists, with nesting. Confluence exports nest deeply and html.ts preserves
// that nesting as two-space indentation; a flat renderer threw the structure
// away and turned "three sub-clauses under clause 2" into six equal clauses.
// An indented line that is not itself an item continues the item above it,
// because that is how html.ts writes an <li> holding more than one block.

function matchListItem(line) {
  const m = /^(\s*)([-*]|\d+[.)])\s+(.*)$/.exec(line ?? '');
  if (!m || isThematicBreak(line)) return null;
  return { indent: m[1].length, ordered: /\d/.test(m[2]), text: m[3] };
}

function parseList(lines, start, indent) {
  const first = matchListItem(lines[start]);
  const ordered = first.ordered;
  const items = [];
  let i = start;
  while (i < lines.length) {
    const item = matchListItem(lines[i]);
    if (item && item.indent > indent && items.length) {
      // Deeper than this list: a sub-list belonging to the item above it.
      const nested = parseList(lines, i, item.indent);
      items[items.length - 1].blocks.push(nested.html);
      i = nested.next;
      continue;
    }
    if (item && item.indent >= indent && item.ordered === ordered) {
      items.push({ text: item.text, blocks: [] });
      i++;
      continue;
    }
    if (item) break; // a shallower item, or the other kind of list: not ours
    // A continuation line: indented, not blank, not the start of some other
    // block. It belongs to the item above rather than to a new paragraph.
    if (!isMdBlank(lines[i]) && items.length && /^\s{2,}/.test(lines[i]) && !startsMdBlock(lines, i)) {
      items[items.length - 1].text += ` ${lines[i].trim()}`;
      i++;
      continue;
    }
    break;
  }
  const tag = ordered ? 'ol' : 'ul';
  const html = `<${tag}>${items
    .map((it) => `<li>${mdInline(it.text)}${it.blocks.join('')}</li>`)
    .join('')}</${tag}>`;
  return { html, next: i };
}

// ---------------------------------------------------------------------------
// Tables

// Split one row into cells. The outer pipes are optional in GFM and are not
// column breaks; `\|` is a literal pipe and is unescaped here, at the only
// place in the subset where a backslash means anything.
function splitTableRow(line) {
  let s = String(line ?? '').trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (/(^|[^\\])\|$/.test(s)) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let k = 0; k < s.length; k++) {
    if (s[k] === '\\' && s[k + 1] === '|') { cur += '|'; k++; continue; }
    if (s[k] === '|') { cells.push(cur); cur = ''; continue; }
    cur += s[k];
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

// The alignment row, as a list of alignments — or null when the line is not
// one. `:---`, `---:` and `:---:` are left, right and centre; a plain `---`
// leaves the column to the stylesheet.
function tableAlignments(line) {
  if (line == null || !line.includes('|') || !/-/.test(line)) return null;
  const aligns = [];
  for (const cell of splitTableRow(line)) {
    const m = /^(:?)-+(:?)$/.exec(cell);
    if (!m) return null;
    aligns.push(m[1] && m[2] ? 'center' : m[2] ? 'right' : m[1] ? 'left' : null);
  }
  return aligns;
}

// A table is a header row and an alignment row with the same number of cells.
// Insisting on the count keeps a lone `---` under a line of prose a thematic
// break rather than a one-column table.
function isTableStart(lines, i) {
  const header = lines[i];
  if (!header || !header.includes('|') || isThematicBreak(header)) return false;
  const aligns = tableAlignments(lines[i + 1]);
  return aligns !== null && aligns.length === splitTableRow(header).length;
}

function parseTable(lines, start) {
  const header = splitTableRow(lines[start]);
  const aligns = tableAlignments(lines[start + 1]);
  const rows = [];
  let i = start + 2;
  while (i < lines.length && !isMdBlank(lines[i]) && lines[i].includes('|') &&
    !/^(#{1,6}\s|```|\s*>)/.test(lines[i]) && !isThematicBreak(lines[i])) {
    rows.push(splitTableRow(lines[i]));
    i++;
  }
  const width = Math.max(header.length, ...rows.map((r) => r.length));
  const cell = (tag, text, n) => {
    const align = aligns[n];
    return `<${tag}${align ? ` class="md-${align}"` : ''}>${mdInline(text ?? '')}</${tag}>`;
  };
  const row = (cells, tag) =>
    `<tr>${Array.from({ length: width }, (_, n) => cell(tag, cells[n], n)).join('')}</tr>`;
  // The scroll box is not decoration: a plan comparison is six columns wide and
  // the document column is 46rem, so without it the table pushes the whole page
  // sideways and takes the navigation with it.
  const html = `<div class="table-scroll"><table class="md-table">` +
    `<thead>${row(header, 'th')}</thead>` +
    `<tbody>${rows.map((r) => row(r, 'td')).join('')}</tbody>` +
    `</table></div>`;
  return { html, next: i };
}

/**
 * Page ids the current body links to that this reader may not open, supplied by
 * the server with the page (`withheldLinks`).
 *
 * Module-level rather than threaded through renderMarkdown's five call sites,
 * and set immediately before the render that needs it. The editor's live
 * preview renders from the textarea and never sets this, which is deliberate:
 * an author is looking at their own draft and must see exactly what they typed.
 */
let withheldLinkIds = new Set();

function withWithheldLinks(ids, fn) {
  const previous = withheldLinkIds;
  withheldLinkIds = new Set(ids ?? []);
  try {
    return fn();
  } finally {
    withheldLinkIds = previous;
  }
}

// The id inside a Canon page link, in either form the record uses: the stable
// link the product hands out (`/pages/<id>`, with or without the hash route)
// and the wiki-style reference. Mirrors retrieval.ts PAGE_LINK, which is what
// the server tested permission against — the two must agree on what a link is,
// or the renderer redacts something the server did not check, or misses one it
// did.
const PAGE_LINK_HREF = /^#?\/pages\/([A-Za-z0-9][A-Za-z0-9_-]{5,})/;

// What a withheld link leaves behind. Not the label, not a blank, and not a
// styled redaction bar — those all invite a reader to guess at the words under
// them. A phrase, so the sentence it sits in still reads.
const WITHHELD_LINK_HTML =
  '<span class="link-withheld" title="This links to a page you do not have access to.">a page you do not have access to</span>';

function mdInline(raw) {
  let s = esc(raw);
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, href) => {
    // A link to a page this reader cannot open takes its LABEL with it. The
    // label is the leak: whoever wrote the body almost certainly typed the
    // target's title there, and Canon would otherwise hand it to everyone who
    // can read this page. The href goes too — an id is a handle.
    const linked = href.match(PAGE_LINK_HREF);
    if (linked && withheldLinkIds.has(linked[1])) return WITHHELD_LINK_HTML;
    // href is already entity-escaped; allow only benign schemes.
    if (/^(https?:|mailto:|#)/i.test(href)) {
      const external = /^https?:/i.test(href) ? ' target="_blank" rel="noopener noreferrer"' : '';
      return `<a href="${href}"${external}>${text}</a>`;
    }
    return text;
  });
  // The wiki form carries no label, only the id — but an id is still a handle,
  // and leaving it as text tells a reader precisely which page to go and ask
  // about by name.
  s = s.replace(/\[\[\s*([A-Za-z0-9][A-Za-z0-9_-]{5,})\s*\]\]/g, (whole, id) =>
    withheldLinkIds.has(id) ? WITHHELD_LINK_HTML : whole);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, n) => `<code>${codes[Number(n)]}</code>`);
  return s;
}

// ---------------------------------------------------------------------------
// Line diff — LCS-based, computed client-side for version compare.

function diffLines(aText, bText) {
  const a = String(aText ?? '').split('\n');
  const b = String(bText ?? '').split('\n');
  const n = a.length, m = b.length;
  if (n * m > 2_000_000) {
    // Degenerate fallback for very large bodies: whole-file replace.
    return [...a.map((l) => ({ type: 'del', a: l })), ...b.map((l) => ({ type: 'add', b: l }))];
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { rows.push({ type: 'same', a: a[i], b: b[j] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { rows.push({ type: 'del', a: a[i] }); i++; }
    else { rows.push({ type: 'add', b: b[j] }); j++; }
  }
  while (i < n) rows.push({ type: 'del', a: a[i++] });
  while (j < m) rows.push({ type: 'add', b: b[j++] });
  return rows;
}

function changedLines(rows) {
  return rows.filter((r) => r.type !== 'same').length;
}

// The side-by-side table itself, over rows from diffLines. Extracted because
// the diff an approver is shown BEFORE deciding (USER-TESTING.md T4.2) has to
// be the same diff History shows afterwards — the same function, not a second
// one that resembles it and drifts.
//
// `headA` and `headB` are HTML: the callers assemble them out of escaped
// pieces, exactly as the compare view always did.
function diffTableHTML(rows, headA, headB) {
  const cell = (text, cls) =>
    `<td class="diff-cell ${cls}">${text === undefined ? '' : `<span>${esc(text) || '&nbsp;'}</span>`}</td>`;
  return `
    <div class="diff-scroll">
      <table class="diff-table">
        <thead><tr><th>${headA}</th><th>${headB}</th></tr></thead>
        <tbody>
          ${rows.map((r) => {
            if (r.type === 'same') return `<tr>${cell(r.a, '')}${cell(r.b, '')}</tr>`;
            if (r.type === 'del') return `<tr>${cell(r.a, 'del')}${cell(undefined, 'void')}</tr>`;
            return `<tr>${cell(undefined, 'void')}${cell(r.b, 'add')}</tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}

// ---------------------------------------------------------------------------
// Chrome: top bar, identity chip, search (feature-detected)

function renderChrome() {
  const chip = document.getElementById('actor-chip');
  const nav = document.getElementById('topnav');
  // The phone-width disclosure for the nav. It tracks the nav's own hidden
  // state rather than having one of its own: a control that opens something
  // nobody is allowed to see is worse than no control.
  const navToggle = document.getElementById('nav-toggle');
  if (state.actor) {
    nav.hidden = false;
    if (navToggle) navToggle.hidden = false;
    chip.innerHTML = `
      <span class="chip-name">${esc(state.actor.name)}</span>
      ${state.actor.kind === 'agent' ? '<span class="kind-tag agent">agent</span>' : ''}
      <button class="btn subtle" id="switch-actor" title="${state.auth?.viaCookie ? 'Sign out' : 'Switch identity'}">${
        state.auth?.viaCookie ? 'Sign out' : 'Switch'
      }</button>`;
    chip.querySelector('#switch-actor').addEventListener('click', async () => {
      // A cookie session is ended at the server, where the row is deleted; a
      // dev identity is only ever local, so forgetting it is the whole of it.
      if (state.auth?.viaCookie) {
        try { await api('POST', '/auth/logout'); } catch { /* the cookie is cleared either way */ }
        state.auth = null;
      }
      storeActor(null);
      resetFeatures();
      state.ask = null;
      document.getElementById('search-slot').hidden = true;
      const askLink = document.getElementById('nav-ask');
      if (askLink) askLink.hidden = true;
      const sourcesLink = document.getElementById('nav-sources');
      if (sourcesLink) sourcesLink.hidden = true;
      // Gaps is role-scoped harder than the other two — an operator, or an
      // administrator of some collection — so a link left standing from the
      // last identity is a claim about the NEXT one that has not been checked
      // yet: somebody who held neither watched it flash and vanish (fourth
      // round, Dana). Hidden until detectGaps answers for whoever signs in,
      // same as the entries above.
      const gapsLink = document.getElementById('nav-gaps');
      if (gapsLink) gapsLink.hidden = true;
      // Same rule as Gaps: the entry is scoped to what the NEXT identity can
      // do with it, and nothing may be left standing from the last one.
      const importsLink = document.getElementById('nav-imports');
      if (importsLink) importsLink.hidden = true;
      await loadAuth();
      renderChrome();
      location.hash = '#/identity';
      route();
    });
    detectSearch();
    detectAsk();
    detectSources();
    detectGaps();
    detectImports();
    detectMap();
    detectFreshness();
    // The queue's badge is part of the chrome: the first thing somebody who
    // has just signed in should learn is how much is waiting on them.
    refreshQueueNav({ force: true });
  } else {
    nav.hidden = true;
    if (navToggle) navToggle.hidden = true;
    closeNavMenu();
    chip.innerHTML = '';
  }
}

/** Shut the phone menu. Called on sign-out and on every navigation — a menu
 *  left standing over the page you just chose from it is a menu you have to
 *  dismiss before you can read what you asked for. */
function closeNavMenu() {
  document.querySelector('.topbar')?.classList.remove('is-nav-open');
  document.getElementById('nav-toggle')?.setAttribute('aria-expanded', 'false');
}

function wireNavToggle() {
  const toggle = document.getElementById('nav-toggle');
  const bar = document.querySelector('.topbar');
  if (!toggle || !bar) return;
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(open));
    bar.classList.toggle('is-nav-open', open);
  });
}

async function detectSearch() {
  if (state.features.search !== null) {
    document.getElementById('search-slot').hidden = state.features.search !== true;
    return;
  }
  try {
    await api('GET', '/search?q=');
    state.features.search = true;
  } catch (err) {
    // 404 = endpoint not built yet; anything else (400 for a missing/short
    // query, etc.) means the endpoint exists.
    state.features.search = err.status !== 404 && err.status !== 0;
  }
  document.getElementById('search-slot').hidden = state.features.search !== true;
}

// ---------------------------------------------------------------------------
// Freshness: what this deployment actually does about review dates
//
// The editor asks people to set a review date and used to tell them, flatly,
// "when this date passes, the page flips to Needs Update and its owner is
// notified". On a default deployment neither half was true: the sweep ran only
// where an operator had named a maintenance actor and wired a timer, and there
// is no notification surface in the product at all, so an owner with eight
// stale pages saw nothing anywhere.
//
// Both halves are now told the truth. The flip is true everywhere, because the
// sweep ships on a timer (src/freshness.ts). The notification is qualified by
// what the deployment can actually do: with a mail relay it is an email, and
// without one the notice is written to the record's outbox and nothing carries
// it anywhere, which is a thing to say rather than a thing to imply.

let freshnessProbe = null;

async function detectFreshness() {
  if (state.features.freshness === null) {
    freshnessProbe ??= api('GET', '/maintenance/freshness')
      .then((s) => s)
      // An older server without the route: the honest answer is "not known",
      // and every sentence below then falls back to describing the feature
      // rather than promising a deployment's behaviour.
      .catch(() => false);
    const found = await freshnessProbe;
    freshnessProbe = null;
    if (state.features.freshness === null) state.features.freshness = found;
  }
  return state.features.freshness || null;
}

/** Is this page overdue right now, whatever the sweep has got round to? */
function isPastReview(reviewDate) {
  if (!reviewDate) return false;
  return reviewDate < new Date().toISOString().slice(0, 10);
}

/**
 * A page that is past its review date and STILL wearing the Canonical mark.
 *
 * The sweep is not a trigger; it is a pass, so between a date passing and the
 * next pass there is a window where a page is overdue and unmarked. That window
 * is minutes on a running deployment and forever on one whose timer is off — and
 * an external reviewer found exactly the second case: a canonical clinical
 * policy displaying a review date six years past, with no warning of any kind,
 * served to readers and cited as current. The status is the record's answer and
 * only the sweep may change it, so this does not touch the status; it says out
 * loud, on the page, what the reader can already work out from the date, and
 * says which of the two situations they are in.
 */
function overdueNoticeHTML(page) {
  if (page.status !== 'canonical' || !isPastReview(page.reviewDate)) return '';
  const f = state.features.freshness;
  const tail = !f
    ? 'A freshness sweep marks pages like this Needs Update.'
    : f.scheduled
      ? `${esc(SYSTEM_ACTOR_NAME)} sweeps for these every ${esc(fmtDuration(f.intervalMs))} and has not reached ` +
        'this one yet.'
      : `<strong>This deployment is not running the freshness sweep</strong>, so this page keeps the Canonical ` +
        'mark until somebody runs maintenance. Nothing is going to mark it on its own.';
  return `<div class="notice notice-stale">Past its review date (${fmtDate(page.reviewDate)}), and still marked
    Canonical. ${tail}</div>`;
}

/** The sentence under the review-date field. What WILL happen, on this deployment. */
function freshnessPromise() {
  const f = state.features.freshness;
  if (!f) {
    return 'When this date passes, a freshness sweep marks the page Needs Update. It is still the official ' +
      'record and can still be cited, marked as past review, until it is re-approved.';
  }
  if (!f.scheduled) {
    return `<strong>This deployment is not running the freshness sweep, so this date will not flip the page on ` +
      `its own.</strong> ${esc(f.reason ?? '')} The date is still recorded, still queryable, and still shown on ` +
      'the page — but somebody has to run maintenance for it to mean anything.';
  }
  const every = fmtDuration(f.intervalMs);
  // What the owner is actually told, on THIS deployment. Until the queue
  // existed the honest version of this sentence ended "and nothing carries it
  // to the owner" (USER-TESTING.md T2.1): the outbox was written and no screen
  // ever read it. It is read now — the notice appears in the owner's queue,
  // whether or not there is a mail relay to carry it any further.
  const notice = f.ownerNotice === 'email'
    ? 'and its owner is emailed'
    : 'and a notice for its owner is written to the record, where it appears in their ' +
      '<a href="#/queue">queue</a>. ' +
      '<span class="muted">This deployment has no mail relay configured, so it does not travel further ' +
      'than that.</span>';
  return `When this date passes, ${esc(SYSTEM_ACTOR_NAME)} marks the page Needs Update within ${esc(every)}, ` +
    `${notice}`;
}

// Grounded answers are feature-detected the same way search is: probe once,
// treat 404 (and 405) as "not built yet" and any other answer as "it exists".
let askProbe = null; // in-flight probe, shared by every caller

async function detectAsk() {
  if (state.features.ask === null) {
    // The chrome, the view, and the per-page affordance all ask at once on a
    // cold load; they share one probe rather than sending three.
    askProbe ??= api('POST', '/ask', { question: '' })
      .then(() => true)
      // 400 for an empty question means the endpoint is there; 404/405 means
      // it is not, and a network failure is not evidence either way.
      .catch((err) => err.status !== 404 && err.status !== 405 && err.status !== 0);
    const found = await askProbe;
    askProbe = null;
    if (state.features.ask === null) state.features.ask = found;
  }
  const link = document.getElementById('nav-ask');
  if (link) link.hidden = state.features.ask !== true;
  return state.features.ask === true;
}

// Registered external systems are feature-detected exactly as /ask is: one
// probe, 404/405 means the endpoint is not built yet, and until it answers
// the Sources nav entry and the whole admin screen simply are not there.
let sourcesProbe = null;

// Gaps are read by an operator (the whole record) or by a collection's
// administrator (the gaps asked of their own collections) — see
// CanonStore.listGaps. The probe's 403 is still an answer, "the endpoint is
// there and it is not for you", and the nav entry stays hidden for anybody who
// is neither rather than leading to a refusal.
let gapsProbe = null;

async function detectGaps() {
  if (state.features.gaps === null) {
    gapsProbe ??= api('GET', '/gaps')
      .then(() => true)
      .catch(() => false);
    const found = await gapsProbe;
    gapsProbe = null;
    if (state.features.gaps === null) state.features.gaps = found;
  }
  const link = document.getElementById('nav-gaps');
  if (link) link.hidden = state.features.gaps !== true;
  return state.features.gaps === true;
}

async function detectSources() {
  if (state.features.sources === null) {
    sourcesProbe ??= api('GET', '/sources')
      .then(() => true)
      .catch((err) => err.status !== 404 && err.status !== 405 && err.status !== 0);
    const found = await sourcesProbe;
    sourcesProbe = null;
    if (state.features.sources === null) state.features.sources = found;
  }
  const link = document.getElementById('nav-sources');
  if (link) link.hidden = state.features.sources !== true;
  return state.features.sources === true;
}

// Called by the collection and page views: a small "ask within this
// collection" affordance that simply is not there when /ask is not.
async function renderAskAffordance(hostId, collectionId) {
  const host = document.getElementById(hostId);
  if (!host || !(await detectAsk())) return;
  // The view may have re-rendered while the probe was in flight.
  if (!host.isConnected) return;
  host.innerHTML = `<a class="btn subtle ask-btn" href="#/ask/${esc(collectionId)}"
    title="Ask a question answered only from this collection's Canonical pages">Ask this collection</a>`;
}

// WHAT SEARCH COVERS, SAID WHERE SOMEBODY IS SEARCHING.
//
// A page's title is indexed from the moment the page exists; a page's body only
// when a version publishes, because a draft body is work in progress and
// readers search the record rather than each other's half-finished sentences
// (src/search.ts, and USER-TESTING.md T4.6 bug E for how the rule got its
// present shape). The rule is right. Nothing said it.
//
// A new contributor found her own unpublished draft by typing its title, and
// then typed a phrase out of its first paragraph and got "Nothing in the record
// matches" — the same sentence Canon uses when the record genuinely holds
// nothing on a subject. Two different facts, one sentence, and the difference
// between them is whether she should go on looking.
//
// So the dropdown states the boundary in both states: under the hits, where it
// explains why a page she can see did not match, and under the empty line,
// where it is the likeliest reason there is nothing there. The statuses are
// drawn as their own badges rather than written out as words, so the dropdown
// says DRAFT exactly as the tree, the page header and the collection front page
// say it — one vocabulary, one casing, wherever a status is named.
function searchScopeHTML(empty) {
  return `
    <p class="search-scope">Titles are searched for every page you can see. Bodies are searched only where a
      version has published, so a ${badge('draft', 'sm')} or ${badge('in_review', 'sm')} page is matched on its
      title alone${empty ? ' — if you are looking for words inside one, try its title' : ''}.</p>`;
}

// SUPERSESSION, WHERE A READER MEETS THE PAGE.
//
// A page the record has moved on from used to look, in every list somebody
// arrives through, exactly like a page it has not: one status chip, and the
// supersession behind a click nobody had a reason to make. A reader searching
// for the on-call runbook got DRAFT, which says "nobody approved this" and
// does not say "and something replaces it" (REMEDIATION-PLAN.md 1.6).
//
// One chip, one function, used by the search hit and by the collection
// contents table, because two renderings of the same fact drift.
//
// WHAT IT SAYS WHEN THE REPLACEMENT IS NOT SHOWABLE. The server sends
// `{ withheld: true }` when the replacement sits in a collection this reader
// holds no role in (src/supersession.ts). The chip is drawn all the same and
// says only that the page is superseded: the record states that relationship
// about a page this reader holds, and the page at the far end is not named,
// not linked, and not described. Existence, never identity — the answered
// policy question, and the same rule the Related panel already keeps.
//
// The three hovers are three different facts, and the middle one is the one
// the banner on the page already spells out: a replacement Ask cannot draw on
// means nothing has been approved on the subject and THIS page is still what
// the record serves.
function supersededChipHTML(mark) {
  if (!mark) return '';
  const withheld = mark.withheld === true;
  const title = withheld
    ? 'Superseded — the record names a replacement in a collection you do not have access to. Nothing about that page is shown here.'
    : mark.answerable
      ? `Superseded — the record names "${mark.title ?? 'another page'}" as its replacement.`
      : `Superseded — the page named as its replacement is not part of the official record yet, so nothing has been approved on this subject and this page is still what the record serves.`;
  return `<span class="badge badge-superseded sm" title="${esc(title)}">Superseded</span>`;
}

/** One hit, drawn the same way in the dropdown and on the results page —
 *  because two renderings of the same result set drift, and a reader who sees
 *  a page in the dropdown and not on the page it links to has been lied to
 *  by one of them. */
function searchHitHTML(it, { withCollection = null } = {}) {
  const id = it.pageId ?? it.id;
  const title = it.title ?? '(untitled)';
  // The page's own standing, with a pending revision noted separately: a reader
  // arriving through search at a Canonical page with an edit in review must not
  // read it as unreviewed (its Canonical version is still the answer).
  const status = it.status ? pageBadge(it, 'sm') : '';
  // Beside the status and not instead of it: both are true, and a superseded
  // Draft and a superseded Canonical page are different situations.
  const superseded = supersededChipHTML(it.supersededBy);
  const type = it.type ? `<span class="muted">${esc(TYPE_LABELS[it.type] ?? it.type)}</span>` : '';
  const where = withCollection && it.collectionId && withCollection.get(it.collectionId)
    ? `<span class="muted"> · ${esc(withCollection.get(it.collectionId))}</span>`
    : '';
  const snippet = it.snippet ?? it.excerpt ?? '';
  return `<a class="search-hit" href="#/pages/${esc(id)}">
    <span class="search-hit-title">${esc(title)}</span> ${status} ${superseded} ${type}${where}
    ${snippet ? `<span class="search-snippet">${highlightedSnippet(snippet)}</span>` : ''}
  </a>`;
}

/** The results of a search, however the caller got them. `Array.isArray` first
 *  because that is the shape /search has always returned. */
function searchItemsOf(r) {
  return Array.isArray(r) ? r : (r?.results ?? r?.pages ?? r?.hits ?? []);
}

/** Where a submitted search goes. One place, so the box, the Enter key and any
 *  future "see all" link cannot disagree about it. */
function searchRoute(q) {
  return `#/search?q=${encodeURIComponent(q)}`;
}

/**
 * "Did you mean" — asked for only when a search found nothing, and rendered as
 * an OFFER rather than applied. The server verifies that the alternative would
 * actually find something this reader can open before it suggests it (see
 * SearchIndex.suggest); a suggestion that silently re-ran the search would be
 * answering a question nobody asked, which is the same failure as a record
 * that quietly corrects what somebody wrote.
 */
async function searchSuggestionHTML(q) {
  try {
    const r = await api('GET', `/search/suggest?q=${encodeURIComponent(q)}`);
    if (!r?.query) return '';
    return `<p class="search-suggest">Did you mean <a href="${esc(searchRoute(r.query))}">${esc(r.query)}</a>?</p>`;
  } catch {
    // A server without the route says nothing rather than showing an error for
    // a convenience.
    return '';
  }
}

const SEARCH_DROPDOWN_CAP = 12;

function wireSearch() {
  const input = document.getElementById('search-input');
  const results = document.getElementById('search-results');
  let timer = null;
  // Which request the box is waiting for. Two keystrokes produce two requests
  // and nothing guarantees they come back in order — an earlier, slower answer
  // landing last leaves the dropdown showing results for a query the box no
  // longer contains, which is the same class of defect as the audit log's
  // stale count: a listing from one source under a question from another.
  let seq = 0;
  const hide = () => { results.hidden = true; };
  const run = async () => {
    const q = input.value.trim();
    if (q.length < 2) { hide(); return; }
    const mine = ++seq;
    try {
      const r = await api('GET', `/search?q=${encodeURIComponent(q)}`);
      if (mine !== seq) return; // a later keystroke owns the dropdown now
      const items = searchItemsOf(r);
      if (!items.length) {
        // This used to claim the RECORD held no match, from a result set
        // that had already been narrowed to this reader's
        // collections. Under the record's disclosure rule the fix is to stop
        // overclaiming, NOT to report how many hidden pages matched: search
        // takes an arbitrary term, so a hidden-match count is an oracle you
        // could binary-search titles with. Existence is disclosed where the
        // record states a relationship to a page you already hold; it is not
        // disclosed in answer to any question anyone can type.
        results.innerHTML = `<div class="search-empty">Nothing you can see matches.</div>${searchScopeHTML(true)}`;
        results.hidden = false;
        const suggestion = await searchSuggestionHTML(q);
        if (mine === seq && suggestion) {
          results.innerHTML = `<div class="search-empty">Nothing you can see matches.</div>${suggestion}${searchScopeHTML(true)}`;
        }
      } else {
        // A dropdown holds twelve. It used to hold twelve and say nothing
        // about the thirteenth, so the list a reader treated as "the results"
        // was a slice of them with no mark on it.
        const more = items.length > SEARCH_DROPDOWN_CAP
          ? `<a class="search-more" href="${esc(searchRoute(q))}">More matches than fit here — see the results page</a>`
          : `<a class="search-more" href="${esc(searchRoute(q))}">See these on a page you can read and link to</a>`;
        results.innerHTML = items.slice(0, SEARCH_DROPDOWN_CAP).map((it) => searchHitHTML(it)).join('')
          + more + searchScopeHTML(false);
        results.hidden = false;
      }
    } catch (err) {
      if (err.status === 404) { state.features.search = false; document.getElementById('search-slot').hidden = true; }
      else toastError(err);
    }
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, 250);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { hide(); input.blur(); return; }
    // ENTER DID NOTHING. The box is inside no form, so the key that everybody
    // presses after typing a search fell on the floor — and there was nowhere
    // for it to go, because the dropdown was the only surface search had
    // (round seven). It goes to the results page now, which is a route, which
    // means a search is a link somebody can send to a colleague.
    if (e.key === 'Enter') {
      e.preventDefault();
      const q = input.value.trim();
      if (!q) return;
      clearTimeout(timer);
      hide();
      location.hash = searchRoute(q);
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-slot')) hide();
    if (e.target.closest('.search-hit') || e.target.closest('.search-more')) { hide(); input.value = ''; }
  });
}

/**
 * The results page. Search had a dropdown and nothing else: no way to see past
 * twelve hits, no way to keep a search, no way to send one to somebody, and
 * nothing at all for the Enter key to do.
 *
 * It states the same boundary the dropdown states, in the same words, and it
 * makes the same claim about emptiness — "nothing YOU CAN SEE matches" — for
 * the same reason: the result set is permission-scoped and a screen that reads
 * it as a fact about the record is stating something it cannot know.
 */
async function viewSearch(query = {}) {
  const q = (query.q ?? '').trim();
  const collections = await api('GET', '/collections').catch(() => []);
  const names = new Map(collections.map((c) => [c.id, c.name]));

  if (!q) {
    app.innerHTML = `
      <div class="page-narrow">
        <div class="page-head"><h1>Search</h1></div>
        <form class="search-page-form" id="search-page-form">
          <label>What are you looking for?
            <input name="q" type="search" autocomplete="off" placeholder="Search the record&hellip;"></label>
          <button class="btn primary" type="submit">Search</button>
        </form>
        ${searchScopeHTML(false)}
      </div>`;
    wireSearchPageForm();
    return;
  }

  let items = [];
  try {
    // 50, not the dropdown's twelve: this is the surface that exists to show
    // more than a dropdown can. The server caps at 100 either way.
    items = searchItemsOf(await api('GET', `/search?q=${encodeURIComponent(q)}&limit=50`));
  } catch (err) {
    renderErrorPage(err);
    return;
  }

  app.innerHTML = `
    <div class="page-narrow">
      <div class="page-head"><h1>Search</h1></div>
      <form class="search-page-form" id="search-page-form">
        <label>What are you looking for?
          <input name="q" type="search" autocomplete="off" value="${esc(q)}"></label>
        <button class="btn primary" type="submit">Search</button>
      </form>
      ${items.length
        ? `<p class="muted search-count">${items.length} result${items.length === 1 ? '' : 's'} you can see${
            items.length >= 50 ? ', the most relevant first — narrow the words if what you want is not here' : ''
          }.</p>
           <div class="search-results-list">${items.map((it) => searchHitHTML(it, { withCollection: names })).join('')}</div>`
        : `<div class="empty-state">
            <h2>Nothing you can see matches</h2>
            <p>Searching finds pages in the collections you belong to. Somebody else may hold
            material on this subject in a collection you are not a member of.</p>
          </div>`}
      <div id="search-suggest"></div>
      ${searchScopeHTML(!items.length)}
    </div>`;
  wireSearchPageForm();
  if (!items.length) {
    const host = app.querySelector('#search-suggest');
    const suggestion = await searchSuggestionHTML(q);
    if (host?.isConnected) host.innerHTML = suggestion;
  }
}

function wireSearchPageForm() {
  const form = app.querySelector('#search-page-form');
  if (!form) return;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = form.q.value.trim();
    if (q) location.hash = searchRoute(q);
  });
}

// ---------------------------------------------------------------------------
// Router

const app = document.getElementById('app');

function parseHash() {
  // The query is stripped before the path is split. A view that scopes itself
  // with filters keeps them in the hash so the scoped view is a LINK — an
  // auditor pastes "the log for this page, over this fortnight" into a working
  // paper and it still means that tomorrow. Without this split, `#/audit?x=1`
  // parses as the single segment "audit?x=1" and matches no route at all.
  const h = location.hash.replace(/^#/, '').split('?')[0];
  const parts = h.split('/').filter(Boolean).map(decodeURIComponent);
  return parts; // e.g. ['pages', id, 'edit']
}

function hashQuery() {
  const at = location.hash.indexOf('?');
  if (at === -1) return {};
  return Object.fromEntries(new URLSearchParams(location.hash.slice(at + 1)));
}

/**
 * Which nav entry is the place you are standing in.
 *
 * `.active` was the whole of it, which is a colour — and a colour is not a
 * statement. `aria-current="page"` is the statement, and it is what a screen
 * reader reads out ("current page") as it moves through the nav. The two are
 * set together in one place precisely so a future route cannot get one and not
 * the other; there were already three call sites setting the class by hand
 * (round seven: no aria-current anywhere in Canon's nav).
 *
 * `page`, not `true`: the link points at the route you are on, which is
 * exactly what `page` means. `true` is for the weaker "somewhere within".
 */
function markNav(section) {
  document.querySelectorAll('#topnav a').forEach((a) => {
    const here = a.dataset.nav === section;
    a.classList.toggle('active', here);
    if (here) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

/**
 * What a route change has to do besides draw.
 *
 * Canon had nine routes and one title. `document.title` was set once in
 * index.html and never reassigned, so the browser tab, the history entry, the
 * bookmark and the screen reader's window announcement all read "Veryl Canon"
 * whether you were on the audit log or in an editor. A sighted mouse user
 * never notices; somebody navigating by tab or by voice has no other signal
 * that the page moved at all, because the DOM swap under a single-page router
 * fires nothing.
 *
 * Three things, in the order they matter:
 *
 *   1. THE TITLE, from the view's own <h1>. Not a hand-maintained table of
 *      route → name: that is a second copy of every heading in the app and it
 *      would drift the first time somebody renamed a screen. The heading a
 *      reader sees IS the name of the place.
 *   2. FOCUS onto that heading, so the next Tab starts at the content rather
 *      than back at the top of the chrome — the same 85 tab stops the skip
 *      link exists for, met from the other side.
 *   3. AN ANNOUNCEMENT in a polite live region. A title change is not reliably
 *      spoken in a single-page app; a live region is. It carries the same
 *      words as the title so the two cannot say different things.
 *
 * Only `render()` calls this, and only route() and two retry paths call
 * `render()` — so an in-page refresh (closing a gap, resolving a comment) does
 * NOT steal focus. That boundary is the point: focus moves when you have
 * gone somewhere, and never because a panel redrew under your hands.
 */
function announceRoute() {
  const heading = app.querySelector('h1') ?? app.querySelector('h2');
  const name = (heading?.textContent ?? '').replace(/\s+/g, ' ').trim();
  document.title = name ? `${name} · Veryl Canon` : 'Veryl Canon';
  if (heading) {
    // Non-interactive, so it needs a tabindex to hold focus, and -1 so it
    // never becomes a tab stop of its own. preventScroll because the view has
    // already put the reader where it wants them (a page opened at an anchor,
    // a restored scroll); focus is about where the CURSOR is.
    heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
  } else {
    app.focus({ preventScroll: true });
  }
  const announcer = document.getElementById('route-announcer');
  if (announcer) announcer.textContent = name || 'Veryl Canon';
}

/**
 * The skip link. Its default is prevented and focus is moved by hand, because
 * `location.hash` is this app's router: letting `href="#main"` through would
 * navigate to the route "main", which does not exist, and drop the reader on
 * the collections list. The link still reads and behaves as a link.
 */
function wireSkipLink() {
  const link = document.getElementById('skip-to-main');
  if (!link) return;
  link.addEventListener('click', (e) => {
    e.preventDefault();
    const heading = app.querySelector('h1') ?? app;
    heading.setAttribute('tabindex', '-1');
    heading.focus();
    heading.scrollIntoView({ block: 'start' });
  });
}

async function route() {
  const parts = parseHash();
  if (!state.actor && parts[0] !== 'identity') {
    state.afterIdentity = location.hash || '#/';
    await render(viewIdentity);
    return;
  }
  // `#/inbox`, `#/me` and `#/mine` were the three other things people typed
  // when they went looking for their own work, and all three used to fall
  // through to the home view without a word (USER-TESTING.md T2.1). They are
  // the same request as `#/queue`, so they rewrite to it — `replace`, not an
  // assignment, so the alias does not sit in the history for Back to land on.
  if (parts[0] === 'inbox' || parts[0] === 'me' || parts[0] === 'mine') {
    location.replace(`${location.pathname}${location.search}#/queue`);
    return;
  }
  const section = parts[0] === 'audit' ? 'audit'
    : parts[0] === 'gaps' ? 'gaps'
    : parts[0] === 'ask' ? 'ask'
    : parts[0] === 'sources' ? 'sources'
    : parts[0] === 'imports' ? 'imports'
    : parts[0] === 'queue' ? 'queue'
    : 'home';
  markNav(section);
  closeNavMenu();
  // The badge is refreshed on every navigation, and cached for a few seconds
  // (loadQueue), so moving around the record does not re-run the queue. It is
  // deliberately NOT awaited: a number arriving a moment after the page is a
  // number, and a page that waits for it is a slower page.
  refreshQueueNav();
  try {
    if (parts.length === 0) return await render(viewHome);
    if (parts[0] === 'identity') return await render(viewIdentity);
    if (parts[0] === 'queue') return await render(viewQueue);
    if (parts[0] === 'audit') return await render(() => viewAudit(hashQuery()));
    if (parts[0] === 'gaps') return await render(() => viewGaps(hashQuery()));
    if (parts[0] === 'sources') return await render(viewSources);
    if (parts[0] === 'imports') {
      return await render(() => (parts[1] ? viewImportRun(parts[1]) : viewImports()));
    }
    if (parts[0] === 'search') return await render(() => viewSearch(hashQuery()));
    if (parts[0] === 'ask') return await render(() => viewAsk(parts[1] ?? null));
    if (parts[0] === 'map') return await render(() => viewMap(parts[1] ?? null));
    if (parts[0] === 'collections' && parts[1] && parts[2] === 'map') {
      return await render(() => viewMap(parts[1]));
    }
    if (parts[0] === 'collections' && parts[1] && parts[2] === 'members') {
      return await render(() => viewCollectionMembers(parts[1]));
    }
    if (parts[0] === 'collections' && parts[1]) return await render(() => viewCollection(parts[1]));
    if (parts[0] === 'pages' && parts[1]) {
      const id = parts[1];
      if (parts[2] === 'edit') return await render(() => viewEditor(id));
      if (parts[2] === 'history') return await render(() => viewHistory(id));
      if (parts[2] === 'versions' && parts[3]) return await render(() => viewVersion(id, Number(parts[3])));
      if (parts[2] === 'compare' && parts[3] && parts[4]) {
        return await render(() => viewCompare(id, Number(parts[3]), Number(parts[4])));
      }
      return await render(() => viewPage(id));
    }
    return await render(viewHome);
  } catch (err) {
    renderErrorPage(err);
  }
}

async function render(view) {
  app.innerHTML = '<div class="loading">Loading…</div>';
  try {
    await view();
  } catch (err) {
    renderErrorPage(err);
  }
  // After the failure path too: "Not found" is a place you arrived at, and it
  // is the one a lost reader most needs told to them.
  announceRoute();
}

function renderErrorPage(err) {
  const msg = err?.message ?? 'Something went wrong.';
  // THE WALL, AND SOMETHING TO DO AT IT. `forbiddenRole` already answers with
  // the structured refusal beside its sentence — `{ collectionId, needed,
  // held }` — so the one screen a refused person actually lands on can carry
  // the ask. Only where they HOLD something there: access.ts refuses a ground
  // on a collection somebody holds nothing in, because a refusal you have no
  // standing over gives you nothing to carry, and accepting one would turn the
  // request endpoint into a place to type ids at (policy question 1).
  const d = err?.details ?? {};
  const canAsk = err?.status === 403 && d.collectionId && d.held && d.held !== 'admin';
  app.innerHTML = `
    <div class="page-narrow">
      <div class="empty-state">
        <h2>${err?.status === 403 ? 'No access' : err?.status === 404 ? 'Not found' : 'Something went wrong'}</h2>
        <p>${esc(msg)}</p>
        <p><a class="btn" href="#/">Back to collections</a>${canAsk
          ? ` <button type="button" class="btn primary ask-access" data-ask-access data-ground="collection"
              data-collection="${esc(d.collectionId)}" data-held="${esc(d.held)}">Ask for access</button>`
          : ''}</p>
      </div>
    </div>`;
  if (canAsk) wireAskAccess();
}

// ---------------------------------------------------------------------------
// Identity screen (dev sign-in)

async function viewIdentity() {
  if (!state.auth) await loadAuth();
  const sso = state.auth?.sso === true;
  const dev = state.auth?.devAuth === true;

  // With SSO configured this is a real sign-in: the browser leaves for the
  // organization's identity provider and comes back with a session cookie.
  // The dev picker below it survives only where the server has kept the dev
  // door open, and says out loud that it verifies nothing.
  if (!dev) {
    app.innerHTML = `
      <div class="identity-wrap">
        <div class="identity-card">
          <h1>Sign in</h1>
          ${sso ? `
            <p class="muted">Canon uses your organization's single sign-on. You will be sent to your
            identity provider and returned here.</p>
            <p><button class="btn primary" id="sso-signin">Sign in with your organization account</button></p>`
          : `
            <p class="form-error">No sign-in is configured on this server.</p>
            <p class="muted">An administrator sets <code>CANON_OIDC_ISSUER</code> for single sign-on, or
            <code>CANON_DEV_AUTH=true</code> for the development identity picker.</p>`}
        </div>
      </div>`;
    const btn = app.querySelector('#sso-signin');
    if (btn) {
      btn.addEventListener('click', () => {
        const back = state.afterIdentity && state.afterIdentity !== '#/identity' ? state.afterIdentity : '#/';
        location.href = `/auth/login?return=${encodeURIComponent('/' + back)}`;
      });
    }
    return;
  }

  let actors = [];
  let loadError = null;
  try {
    actors = await api('GET', '/auth/dev/actors');
  } catch (err) {
    loadError = err;
  }
  app.innerHTML = `
    <div class="identity-wrap">
      <div class="identity-card">
        <h1>Who are you?</h1>
        <p class="muted">Development sign-in. Identity travels as the <code>X-Actor-Id</code> header and
        <strong>nothing about it is verified</strong> — this server was started with
        <code>CANON_DEV_AUTH=true</code>. Agents authenticate with an Agent Passport instead.</p>
        ${sso ? '<p><button class="btn primary" id="sso-signin">Sign in with your organization account</button></p>' : ''}
        ${loadError ? `<p class="form-error">${esc(loadError.message)}</p>` : ''}
        <div class="identity-list">
          ${actors.length ? actors.map((a) => `
            <button class="identity-row" data-pick="${esc(a.id)}">
              <span class="identity-name">${esc(a.name)}</span>
              ${kindTag(a.kind)}
              ${a.email ? `<span class="muted">${esc(a.email)}</span>` : ''}
            </button>`).join('') : '<p class="muted identity-none">No one is registered yet. Create the first actor below.</p>'}
        </div>
        <hr>
        <h2 class="h-small">New actor</h2>
        <form id="new-actor-form" class="stack">
          <label>Name <input name="name" required maxlength="120" placeholder="e.g. Dana Whitfield"></label>
          <label>Email <input name="email" type="email" placeholder="optional"></label>
          <label>Kind
            <select name="kind">
              <option value="person">Person</option>
              <option value="agent">Agent</option>
            </select>
          </label>
          <label id="registry-ref-row" hidden>Registry reference (Agent Passport)
            <input name="registryRef" placeholder="e.g. passport:acme/helper-1">
          </label>
          <div><button class="btn primary" type="submit">Create and continue</button></div>
        </form>
      </div>
    </div>`;

  const ssoBtn = app.querySelector('#sso-signin');
  if (ssoBtn) {
    ssoBtn.addEventListener('click', () => {
      const back = state.afterIdentity && state.afterIdentity !== '#/identity' ? state.afterIdentity : '#/';
      location.href = `/auth/login?return=${encodeURIComponent('/' + back)}`;
    });
  }

  app.querySelectorAll('[data-pick]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const actor = actors.find((a) => a.id === btn.dataset.pick);
      storeActor({ id: actor.id, name: actor.name, kind: actor.kind });
      state.actors = null;
      renderChrome();
      location.hash = state.afterIdentity && state.afterIdentity !== '#/identity' ? state.afterIdentity : '#/';
      state.afterIdentity = null;
      route();
    });
  });

  const form = app.querySelector('#new-actor-form');
  form.kind.addEventListener('change', () => {
    app.querySelector('#registry-ref-row').hidden = form.kind.value !== 'agent';
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const body = {
        kind: form.kind.value,
        name: form.name.value.trim(),
      };
      if (form.email.value.trim()) body.email = form.email.value.trim();
      if (form.kind.value === 'agent') body.registryRef = form.registryRef.value.trim();
      const actor = await api('POST', '/actors', body);
      storeActor({ id: actor.id, name: actor.name, kind: actor.kind });
      state.actors = null;
      renderChrome();
      location.hash = state.afterIdentity && state.afterIdentity !== '#/identity' ? state.afterIdentity : '#/';
      state.afterIdentity = null;
      route();
    } catch (err) {
      toastError(err);
    }
  });
}

// ---------------------------------------------------------------------------
// Collections home

async function viewHome() {
  const [collections] = await Promise.all([api('GET', '/collections'), loadActors().catch(() => null)]);
  app.innerHTML = `
    <div class="page-wide">
      <div class="page-head">
        <h1>Collections</h1>
        <button class="btn primary" id="new-collection">New collection</button>
      </div>
      ${collections.length ? `
        <div class="card-grid">
          ${collections.map((c) => `
            <a class="card collection-card" href="#/collections/${esc(c.id)}">
              <h3>${esc(c.name)} ${c.restricted ? restrictedTagHTML() : ''}</h3>
              <p class="muted">${esc(c.description || 'No description.')}</p>
              <p class="card-foot muted">Created ${fmtDateTime(c.createdAt)}</p>
            </a>`).join('')}
        </div>` : `
        <div class="empty-state">
          <h2>The record starts here</h2>
          <p>Collections hold your organization's knowledge: one per team, department, or
          domain. Create the first collection, then add pages of the four Core types —
          Policy, Spec, Plan, and Note.</p>
          <p><button class="btn primary" id="new-collection-empty">Create your first collection</button></p>
        </div>`}
    </div>`;

  const openCreate = () => openModal({
    title: 'New collection',
    submitLabel: 'Create',
    body: `
      <label>Name <input name="name" required maxlength="120" placeholder="e.g. Compliance"></label>
      <label>Description <textarea name="description" rows="2" placeholder="What this collection holds (optional)"></textarea></label>
      ${/* WHAT "RESTRICTED" ACTUALLY DOES, because the word promises the one
            thing it does not do.

            Round seven, tester 47: a restricted and an unrestricted collection
            are IDENTICALLY invisible to a non-member — membership is the whole
            of access control, on every collection. A department head reading
            "Restricted" beside a checkbox reasonably concludes it is what keeps
            people out, and the only helper text under it talked about the audit
            log. Two of the three sentences below were nowhere in the product:
            that this grants no access control (store.ts: no permission check
            reads the flag), and that it holds these pages back from an outside
            model (answers.ts `egressWithheld`, embeddings.ts `enqueue`, both
            keyed on the same column). */ ''}
      <label class="check"><input type="checkbox" name="restricted"> Restricted
        <span class="muted">extra scrutiny, not extra access control</span></label>
      <p class="muted type-help">Who can open a collection is decided by its members, restricted or
        not. Ticking this records every read of a page here in the audit log — including reads that
        were refused — and keeps these pages from being sent to an outside AI service, unless this
        Canon has been set up to allow that.</p>`,
    onSubmit: async (form) => {
      const c = await api('POST', '/collections', {
        name: form.name.value.trim(),
        description: form.description.value.trim(),
        restricted: form.restricted.checked,
      });
      toast(`Collection "${c.name}" created.`, 'ok');
      location.hash = `#/collections/${c.id}`;
    },
  });
  app.querySelector('#new-collection')?.addEventListener('click', openCreate);
  app.querySelector('#new-collection-empty')?.addEventListener('click', openCreate);
}

// ---------------------------------------------------------------------------
// The queue (USER-TESTING.md T2.1)
//
// "There isn't one. Five nav items, none scoped to me... I found my work by
// walking five collection sidebars, eyeballing 44 badges, and opening every one
// of those 44 pages to read the Approver field — the sidebar doesn't show it.
// 25 were mine. Did I believe I'd found all of it? No, and I still don't."
//
// One screen, one call, six strands, and — the part that answers what he
// actually complained about — a NUMBER BESIDE THE NAV ITEM. He did not fail to
// find a page; he failed to be told there was anything to find. The count is
// most of the value and it is the cheapest thing here.
//
// Everything on this screen comes from GET /queue, which is assembled server-
// side from reads that filter by permission in their SELECT (queue.ts). The UI
// composes nothing and asks about nobody: there is no actor parameter to send.
//
// #/queue IS THE ROUTE. `#/inbox`, `#/me` and `#/mine` were the three other
// things people typed, and all four used to redirect home in silence; they now
// rewrite to this one rather than being three more names for it, so a
// bookmarked link keeps working and the address bar still says where you are.

/** How long the nav badge trusts its last answer before asking again. */
const QUEUE_CACHE_MS = 20_000;

/**
 * Fetch the queue, at most once every QUEUE_CACHE_MS unless forced, sharing
 * one in-flight request between the nav badge and the view.
 *
 * A server that does not have the route (an older deployment behind a newer
 * page) answers 404, and the nav entry simply is not there — the same
 * feature-detection every other optional surface here gets. Any other failure
 * leaves the last known answer alone: a badge that flickers to zero because one
 * request timed out is worse than a badge that is thirty seconds old.
 */
async function loadQueue({ force = false } = {}) {
  if (!state.actor) return null;
  if (!force && state.queue.data && Date.now() - state.queue.at < QUEUE_CACHE_MS) return state.queue.data;
  if (state.queue.loading) return state.queue.loading;
  state.queue.loading = (async () => {
    try {
      const data = await api('GET', '/queue');
      state.queue.data = data;
      state.queue.at = Date.now();
      state.features.queue = true;
      return data;
    } catch (err) {
      if (err.status === 404 || err.status === 405) state.features.queue = false;
      throw err;
    } finally {
      state.queue.loading = null;
    }
  })();
  return state.queue.loading;
}

/** The nav entry and its count. Called on every route, and after any act that could change it. */
async function refreshQueueNav({ force = false } = {}) {
  const link = document.getElementById('nav-queue');
  const count = document.getElementById('nav-queue-count');
  if (!link || !state.actor) return;
  let data = null;
  try {
    data = await loadQueue({ force });
  } catch {
    // Feature-detection sets the flag; anything else keeps the last answer.
  }
  link.hidden = state.features.queue === false;
  if (!count) return;
  const total = Number(data?.counts?.total ?? state.queue.data?.counts?.total ?? 0);
  count.hidden = total === 0;
  count.textContent = total > 99 ? '99+' : String(total);
  // The number is announced, because it is the whole point of putting it here.
  link.setAttribute('aria-label', total ? `My queue, ${total} waiting` : 'My queue');
  // The same number on the phone-width menu button. Behind a closed menu the
  // badge is invisible, and a badge nobody sees is a badge that does not work
  // — the reason to open the menu has to be on the outside of it.
  const toggleCount = document.getElementById('nav-toggle-count');
  const toggle = document.getElementById('nav-toggle');
  if (toggleCount) {
    toggleCount.hidden = total === 0;
    toggleCount.textContent = count.textContent;
  }
  if (toggle) toggle.setAttribute('aria-label', total ? `Menu, ${total} waiting in your queue` : 'Menu');
}

/**
 * Where a notice points, as a hash route. The outbox stores server-side paths
 * (`/pages/<id>`, sometimes with a `#comment-…` fragment); this router reads
 * one hash and would take the fragment for part of the page id, so the fragment
 * is dropped and the notice lands on the page it is about.
 */
function noticeHref(link) {
  const path = String(link ?? '').split('#')[0];
  return path.startsWith('/') ? `#${path}` : '#/';
}

/**
 * One strand: a heading that states what the list is, and the list.
 *
 * An EMPTY strand is still drawn, and that is deliberate. The question Marcus
 * could not answer was not "where is my work" but "have I found all of it" —
 * "No, and I still don't". A strand that says *nothing is waiting on your
 * approval* is an answer to that question; a strand that quietly disappears
 * when it is empty is indistinguishable from a strand that was never asked.
 * It is drawn small, though: the explanatory line is for a strand that has
 * something in it to explain.
 */
function queueSection(title, blurb, rows, emptyLine) {
  if (!rows.length) {
    return `
      <section class="queue-strand queue-strand-empty">
        <h2 class="queue-strand-head">${esc(title)}</h2>
        <p class="muted queue-empty">${esc(emptyLine)}</p>
      </section>`;
  }
  return `
    <section class="queue-strand">
      <h2 class="queue-strand-head">${esc(title)} <span class="queue-strand-count">${rows.length}</span></h2>
      <p class="muted queue-strand-blurb">${blurb}</p>
      <div class="table-scroll"><table class="table queue-table"><tbody>${rows.join('')}</tbody></table></div>
    </section>`;
}

/**
 * One page in a strand: what it is, where it lives, the one fact this strand
 * turns on, and — where a strand has one — the sentence somebody wrote about
 * it. The send-back comment is shown rather than hidden behind a hover: an
 * author who has to guess what to change is back where the send-back left them.
 */
function queuePageRow(page, collections, right, note = null) {
  const collection = collections.get(page.collectionId);
  return `
    <tr>
      <td>
        <a href="#/pages/${esc(page.pageId)}">${esc(page.title)}</a>
        <div class="queue-meta muted">${esc(TYPE_LABELS[page.type] ?? page.type)}
          · ${esc(collection?.name ?? 'a collection')}</div>
        ${note ? `<div class="queue-note">${esc(note)}</div>` : ''}
      </td>
      <td class="nowrap">${badge(page.status, 'sm')}</td>
      <td class="nowrap queue-when">${right}</td>
    </tr>`;
}

async function viewQueue() {
  markNav('queue');
  let queue;
  try {
    queue = await loadQueue({ force: true });
  } catch (err) {
    if (err.status === 404 || err.status === 405) {
      app.innerHTML = `
        <div class="page-narrow">
          <div class="empty-state">
            <h2>No queue on this server</h2>
            <p>This deployment does not serve <code>GET /queue</code>, so there is nothing to scope to you.</p>
            <p><a class="btn" href="#/">Back to collections</a></p>
          </div>
        </div>`;
      return;
    }
    throw err;
  }
  const [collectionList] = await Promise.all([api('GET', '/collections'), loadActors().catch(() => null)]);
  const collections = new Map(collectionList.map((c) => [c.id, c]));

  // The send-back comment lives in the audit event and in the notice the
  // outbox wrote; the queue reads it off the notice, which is the one place a
  // reader can already be shown it. Newest wins, per page.
  const sendBackReason = new Map();
  for (const n of [...(queue.notices ?? [])].reverse()) {
    if (n.kind !== 'draft_sent_back') continue;
    const id = /^\/pages\/([^/#?]+)/.exec(n.link ?? '')?.[1];
    if (id) sendBackReason.set(id, n.body);
  }

  const c = queue.counts ?? {};
  const nothing = !c.total && !(queue.notices ?? []).length && !(queue.accessRequests ?? []).length
    && !(queue.accessAsked ?? []).length;

  const strands = [
    queueSection(
      'Waiting for your approval',
      'Pages In Review that <strong>you</strong> can grant the Canonical mark to — the approver named on the ' +
        'draft under review, which is the approver the server will accept.',
      (queue.awaitingMyApproval ?? []).map((p) =>
        queuePageRow(p, collections, `waiting ${esc(fmtAgo(p.updatedAt) ?? '')}`),
      ),
      'Nothing is waiting on your approval.',
    ),
    queueSection(
      'Sent back to you',
      'An approver returned these with a comment. They are drafts again, and yours to edit.',
      (queue.sentBackToMe ?? []).map((p) =>
        queuePageRow(p, collections, esc(fmtAgo(p.updatedAt) ?? ''), sendBackReason.get(p.pageId) ?? null),
      ),
      'Nothing has been sent back to you.',
    ),
    queueSection(
      'Yours, and out of date',
      'Pages you own whose review date has passed. They still carry the mark they were given and can still be ' +
        'cited; they come back to Canonical the ordinary way — edit, submit, and the named approver accepts.',
      (queue.myPagesPastReview ?? []).map((p) =>
        queuePageRow(p, collections, `review due ${esc(fmtDate(p.reviewDate))}`),
      ),
      'Nothing you own is past its review date.',
    ),
    queueSection(
      'Contradicted',
      'Somebody asserted that a page you own conflicts with another page. Canon never resolves one — a person ' +
        'settles it, and the record keeps what they said.',
      (queue.conflictsOnMyPages ?? []).map((r) => `
        <tr>
          <td>
            <a href="#/pages/${esc(r.mine.id)}">${esc(r.mine.title)}</a>
            <div class="queue-meta muted">conflicts with
              ${r.other?.withheld
                ? `<span class="rel-target-withheld">${esc(WITHHELD_TARGET)}</span>`
                : `<a href="#/pages/${esc(r.other.id)}">${esc(r.other.title)}</a>`}
              · asserted by ${esc(actorName(r.assertedBy))}</div>
            ${r.other?.withheld
              ? `<div class="queue-note muted">The reason describes that page, so it is not shown here.
                  You own this one; ask ${esc(actorName(r.assertedBy))} what it conflicts with.</div>`
              : r.note ? `<div class="queue-note">${esc(r.note)}</div>` : ''}
          </td>
          <td class="nowrap">${badge(r.mine.status, 'sm')}</td>
          <td class="nowrap queue-when">${esc(fmtAgo(r.assertedAt) ?? '')}</td>
        </tr>`),
      // Now a complete statement again, and it was not before. This list used
      // to DROP a conflict whose other end the reader could not see, so the
      // owner of a contested page was told nothing contested it — the exact
      // silence this queue exists to break. Withheld conflicts are listed, so
      // the empty state can go back to being about the record.
      'No conflict has been asserted against a page you own.',
    ),
    queueSection(
      'Sources disagreeing',
      'A corroborating system is answering differently from the system that owns the fact, on a page you own. ' +
        'Canon records the disagreement and decides nothing.',
      (queue.divergencesOnMyPages ?? []).map((d) => `
        <tr>
          <td>
            <a href="#/pages/${esc(d.pageId)}">${esc(d.pageTitle ?? 'the page')}</a>
            <div class="queue-meta muted">the authority says
              ${esc(referenceValueText(d.authorityValue) ?? 'nothing')}, a corroborating source says
              ${esc(referenceValueText(d.otherValue) ?? 'nothing')}</div>
          </td>
          <td class="nowrap"><span class="badge badge-unresolved sm">open</span></td>
          <td class="nowrap queue-when">${esc(fmtAgo(d.observedAt) ?? '')}</td>
        </tr>`),
      'No source is contradicting a page you own.',
    ),
    queueSection(
      'Your drafts',
      'Unpublished work you hold the lock on. Nobody else can see it and nobody else can edit it.',
      (queue.myDrafts ?? []).map((p) => queuePageRow(p, collections, `edited ${esc(fmtAgo(p.updatedAt) ?? '')}`)),
      'You have no drafts in progress.',
    ),
  ];

  // WAITING ON SOMEBODY ELSE, and outside the count.
  //
  // "Your drafts" leaves out a page that is In Review, because the move is the
  // approver's — right about whose turn it is, wrong about what the author
  // needs. Someone who submitted a policy on Tuesday read "You have no drafts
  // in progress" on Wednesday: true, and it reads as "nothing of yours is in
  // flight" while their work sits in somebody else's queue with no way to find
  // out whose or for how long.
  //
  // Uncounted for the same reason the notices are: the badge is a number of
  // things waiting on YOU, and this is the one strand that is explicitly not.
  const submitted = (queue.awaitingSomebodyElse ?? []).map((p) => queuePageRow(
    p,
    collections,
    `submitted ${esc(fmtAgo(p.updatedAt) ?? '')}`,
    // The approver by name, because "who do I chase" is the whole question. A
    // type that names no single approver says so rather than inventing one.
    p.approverId ? `Waiting on ${actorName(p.approverId)}.` : 'Waiting on anyone who can approve it.',
  ));

  // THE ADMIN INBOX (access.ts). A strand rather than a screen of its own, for
  // the reason the notices are one: this is the screen people check, and the
  // whole finding was that a request went nowhere anybody looked. It IS
  // counted, unlike the notices, because somebody is waiting on a decision
  // only this person can make.
  const accessRequests = (queue.accessRequests ?? []).map((r) => accessRequestCardHTML(r));
  const accessAsked = (queue.accessAsked ?? []).map((r) => askedAccessRowHTML(r, collections));

  // Notices last, and outside the count. The outbox has no read state, so a
  // number counting these would never go down; what they add is the sentence —
  // who asked, who sent it back, what they said — beside the work itself.
  const notices = (queue.notices ?? []).map((n) => `
    <li class="queue-notice">
      <span class="queue-notice-kind">${esc(NOTIFICATION_LABELS[n.kind] ?? n.kind)}</span>
      <a href="${esc(noticeHref(n.link))}">${esc(n.subject)}</a>
      <div class="queue-meta muted">${esc(n.body)}</div>
      <div class="queue-meta muted">${esc(fmtAgo(n.createdAt) ?? '')}${
        n.sentAt ? '' : ' · <span class="queue-unsent">not yet delivered</span>'
      }</div>
    </li>`);

  app.innerHTML = `
    <div class="page-wide">
      <div class="page-head">
        <h1>My queue</h1>
        <div class="actions"><button class="btn subtle" id="queue-refresh">Refresh</button></div>
      </div>
      <p class="muted queue-lede">Everything the record is waiting on <strong>you</strong> for, across every
      collection you belong to. Nothing here is somebody else's work, and nothing here is a page you could not
      already open.</p>
      ${nothing ? `
        <div class="empty-state">
          <h2>Nothing is waiting on you</h2>
          <p>No approvals, no pages of yours past review, no contradictions against anything you own, and
          no drafts in progress.${submitted.length
            ? ' You do have work with somebody else — it is below.'
            : ''}</p>
        </div>` : strands.join('')}
      ${submitted.length ? `
        <section class="queue-strand">
          <h2 class="queue-strand-head">Waiting on somebody else</h2>
          <p class="muted queue-strand-blurb">Work you submitted. It is not counted above: the number is what
          the record is waiting on <strong>you</strong> for, and these are waiting on someone else.</p>
          <table class="queue-table"><tbody>${submitted.join('')}</tbody></table>
        </section>` : ''}
      ${accessRequests.length ? `
        <section class="queue-strand">
          <h2 class="queue-strand-head">People asking for access <span class="queue-strand-count">${
            accessRequests.length}</span></h2>
          <p class="muted queue-strand-blurb">Somebody was refused something and asked. Only an administrator of
          the collection can decide, which is why this is here and not in a list somebody else could clear.</p>
          ${accessRequests.join('')}
        </section>` : ''}
      ${accessAsked.length ? `
        <section class="queue-strand">
          <h2 class="queue-strand-head">Access you have asked for</h2>
          <p class="muted queue-strand-blurb">Waiting on somebody else, so it is not counted above. You will be
          told either way; a request about a page you cannot see does not name it here, which is the same rule
          that withheld it.</p>
          <ul class="asked-access-list">${accessAsked.join('')}</ul>
        </section>` : ''}
      ${notices.length ? `
        <section class="queue-strand">
          <h2 class="queue-strand-head">Notices</h2>
          <p class="muted queue-strand-blurb">What Canon has told you. These are not counted in the badge:
          the record keeps no read state for them, so a number here would never go down.</p>
          <ul class="queue-notices">${notices.join('')}</ul>
        </section>` : ''}
      ${queue.truncated ? `
        <p class="muted queue-truncated">One of these lists is showing as much as this screen carries. There is
        more; narrow it with a <a href="#/">collection</a> or a query.</p>` : ''}
    </div>`;

  wireAccessRequests(() => route());
  app.querySelector('#queue-refresh')?.addEventListener('click', async () => {
    await refreshQueueNav({ force: true });
    route();
  });
  await refreshQueueNav();
}

// ---------------------------------------------------------------------------
// Asking for access, from the refusal that made you want it
//
// Two testers, one sentence: "The wall already names who holds the role; it
// should be able to ask for them. Administrators have no inbox of requests
// either." Both halves are here — the control on the refusal, and the strand in
// the queue where a request lands, because a request nobody can see is worse
// than no request.
//
// WHAT THE CONTROL SENDS is the refusal's own context and never a page
// somebody names (access.ts has the argument): a collection this reader already
// holds a role on, or a RELATION whose far end they were shown as withheld.
// There is deliberately no box to type an id into. The screen therefore only
// ever offers this where a refusal is on the screen beside it.
//
// AND WHAT COMES BACK is thinner than what goes in. A request about a page the
// asker cannot see names no collection and no page in their own listing —
// a receipt for the asking must not hand over what the refusal withheld.

const ROLE_HELP = {
  view: 'read the pages here',
  comment: 'read, and leave comments',
  edit: 'write and edit drafts here',
  approve: 'grant the Canonical mark',
  admin: 'administer this collection',
};

/** The roles above one somebody already holds, weakest first. */
function rolesAbove(held) {
  const at = held ? ROLES.indexOf(held) : -1;
  return ROLES.slice(at + 1);
}

function askAccessButtonHTML(label = 'Ask for access') {
  return `<button type="button" class="btn subtle ask-access" data-ask-access>${esc(label)}</button>`;
}

/**
 * The dialog. `ground` decides everything about it: what can be asked for, and
 * — the part that matters — what the dialog is allowed to say about what is
 * being asked for.
 */
function openAskAccessModal(context) {
  const { ground, collectionId = null, collectionName = null, held = null, relationId = null } = context;
  const options = ground === 'collection'
    ? rolesAbove(held).map((r, i) =>
        `<option value="${esc(r)}" ${i === 0 ? 'selected' : ''}>${esc(r)} — ${esc(ROLE_HELP[r] ?? '')}</option>`).join('')
    : '';
  openModal({
    title: 'Ask for access',
    submitLabel: 'Send the request',
    body: ground === 'collection'
      ? `
        <p>This goes to the administrators of <strong>${esc(collectionName ?? 'this collection')}</strong>. They
          see your name, what you are asking for, and the sentence you write here.</p>
        <label>What you need to be able to do
          <select name="role">${options}</select></label>
        <label>Why you need it
          <textarea name="note" rows="3" required maxlength="600"
            placeholder="The one thing an administrator decides on. Say what you are trying to do."></textarea></label>
        <p class="muted">You hold <strong>${esc(held ?? 'no role')}</strong> here now. Nothing changes until
          somebody grants it, and you will be told either way.</p>`
      : `
        <p>Something the record says about this page points at a page you cannot see. This asks the
          administrators of whichever collection holds it.</p>
        <label>Why you need it
          <textarea name="note" rows="3" required maxlength="600"
            placeholder="They cannot see your page. Say what you are trying to settle."></textarea></label>
        ${/* The non-disclosure rule, said out loud rather than merely obeyed.
              A reader who does not know the request went somewhere specific
              assumes it went nowhere. */ ''}
        <p class="muted">Canon will not tell you which collection that is, or what the page is called — that is
          the same rule that withheld it in the first place. It will tell you the decision.</p>`,
    onSubmit: async (form) => {
      const note = form.note.value.trim();
      if (!note) throw { message: 'Say what you need to do and why; an administrator decides on that sentence.' };
      await api('POST', '/access-requests', ground === 'collection'
        ? { ground, collectionId, role: form.role.value, note }
        : { ground, relationId, note });
      toast('Asked. It is waiting with the administrators who can grant it.', 'ok');
      await refreshQueueNav({ force: true });
    },
  });
}

/**
 * Wire every `data-ask-access` control inside `host`. The context rides on the
 * element, so one handler serves the page view, the relations panel and the
 * refusal wall without any of them knowing about each other.
 */
function wireAskAccess(host = app) {
  host.querySelectorAll('[data-ask-access]').forEach((btn) => {
    btn.addEventListener('click', () => openAskAccessModal({
      ground: btn.dataset.ground ?? 'collection',
      collectionId: btn.dataset.collection ?? null,
      collectionName: btn.dataset.collectionName ?? null,
      held: btn.dataset.held || null,
      relationId: btn.dataset.relation ?? null,
    }));
  });
}

/** What one request says to the administrator who can answer it. */
function accessRequestCardHTML(r) {
  const asked = r.ground === 'collection'
    ? `for the <strong>${esc(r.requestedRole ?? 'view')}</strong> role here.`
    : `to see <a href="#/pages/${esc(r.subjectPageId ?? '')}">${esc(r.subjectTitle ?? 'a page here')}</a>, which
       one of their own pages is recorded as contradicting.`;
  return `
    <article class="access-card" data-request="${esc(r.id)}">
      <p class="access-ask"><strong>${esc(r.askerName ?? actorName(r.askerId))}</strong> is asking ${asked}</p>
      <p class="access-note">&ldquo;${esc(r.note ?? '')}&rdquo;</p>
      <p class="muted access-meta">${esc(fmtAgo(r.createdAt) ?? '')} · they hold
        ${esc(r.askerRole ?? 'no role')} here</p>
      <div class="access-actions">
        <select class="access-role" aria-label="Role to grant">
          ${ROLES.map((role) => `<option value="${esc(role)}" ${
            role === (r.requestedRole ?? 'view') ? 'selected' : ''}>${esc(role)}</option>`).join('')}
        </select>
        <button class="btn primary" data-decide="granted">Grant</button>
        <button class="btn subtle" data-decide="declined">Decline</button>
        ${/* Required for a decline and not for a grant, and the server keeps
              that rule: a grant writes its own record — the membership, the
              audit event, the access itself — while "no" tells somebody
              nothing they can act on. Same asymmetry as approve and
              send-back. */ ''}
        <input type="text" class="access-decision-note" maxlength="400"
          placeholder="Why not — required to decline, optional to grant">
      </div>
    </article>`;
}

/** And what it says to the person who asked, which is deliberately less. */
function askedAccessRowHTML(r, collections = new Map()) {
  const named = r.collectionId ? collections.get(r.collectionId)?.name : null;
  const what = r.ground === 'collection'
    ? `the ${esc(r.requestedRole ?? 'view')} role on ${r.collectionId
        ? `<a href="#/collections/${esc(r.collectionId)}">${esc(named ?? 'that collection')}</a>`
        : 'a collection'}`
    : `a page ${r.fromPageId
        ? `<a href="#/pages/${esc(r.fromPageId)}">one of your pages</a>`
        : 'one of your pages'} is recorded as contradicting`;
  return `
    <li class="asked-access" data-asked="${esc(r.id)}">
      <span>You asked for ${what}.</span>
      <span class="muted"> ${esc(fmtAgo(r.createdAt) ?? '')} · waiting</span>
      <button class="btn subtle" data-withdraw-access="${esc(r.id)}">Withdraw</button>
    </li>`;
}

/** The inbox and the sent folder, wired. Called by the queue after it draws. */
function wireAccessRequests(reload) {
  app.querySelectorAll('[data-request]').forEach((card) => {
    card.querySelectorAll('[data-decide]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const outcome = btn.dataset.decide;
        const note = card.querySelector('.access-decision-note').value.trim();
        if (outcome === 'declined' && !note) {
          toast('Declining records why, in a sentence the person who asked will read.');
          card.querySelector('.access-decision-note').focus();
          return;
        }
        try {
          await api('POST', `/access-requests/${card.dataset.request}/decide`, {
            outcome,
            role: card.querySelector('.access-role').value,
            note,
          });
          toast(outcome === 'granted' ? 'Granted, and they have been told.' : 'Declined, with your reason.', 'ok');
          reload();
        } catch (err) { toastError(err); }
      });
    });
  });
  app.querySelectorAll('[data-withdraw-access]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api('POST', `/access-requests/${btn.dataset.withdrawAccess}/withdraw`);
        toast('Withdrawn.', 'ok');
        reload();
      } catch (err) { toastError(err); }
    });
  });
}

// ---------------------------------------------------------------------------
// Collection layout helpers (sidebar shared by collection + page views)

function flattenTree(nodes, depth = 0, out = []) {
  for (const n of nodes) {
    out.push({ ...n, depth });
    flattenTree(n.children, depth + 1, out);
  }
  return out;
}

// The tree is the only navigation there is, so a title it cannot show is a
// page a reader cannot reach. It used to clip at the sidebar's width — five
// rows reading "PLAN-7 …" and one reading "Escal…" (USER-TESTING.md T4.6) —
// which is not navigation, it is a list of prefixes. Titles now WRAP: the
// sidebar is wider, the title takes the lines it needs, and the badge follows
// the last word of it rather than competing with it for the row. Nothing is
// ever cut.
//
// A BRANCH IS A BUTTON BESIDE A LINK, not a link inside a <summary>.
//
// It was `<summary><a …></summary>`, which is invalid: <summary> has an
// implicit button role and interactive content may not be nested inside it
// (round seven). A browser renders it, and it half works — which is why it
// survived — but what it hands assistive technology is a button whose accessible
// name is a link, one control claiming two jobs, and a click that had to be
// intercepted globally to stop navigation from also collapsing the branch.
//
// The two jobs are now two controls: a toggle that opens and closes the
// children, and the link to the page. Both are reachable, both say what they
// do, and `aria-expanded`/`aria-controls` state the relationship the <details>
// element used to imply. The cost is that the open/closed state is ours to
// keep rather than the browser's — worth it to stop shipping markup that is
// invalid in the one place a keyboard user has to live.
function treeHTML(nodes, currentPageId) {
  if (!nodes.length) return '<p class="muted tree-empty">No pages yet.</p>';
  const item = (n) => {
    const active = n.id === currentPageId ? ' active' : '';
    const link = `<a class="tree-link${active}" href="#/pages/${esc(n.id)}"
      >${esc(n.title)} ${badge(n.status, 'sm')}</a>`;
    if (n.children.length) {
      const kids = `tree-kids-${esc(n.id)}`;
      return `<li class="branch">
        <div class="tree-row">
          ${/* The name is the branch's title, so a screen reader hears what is
                being collapsed rather than "button, triangle". */ ''}
          <button type="button" class="tree-branch-toggle" aria-expanded="true"
            aria-controls="${kids}" aria-label="Pages under ${esc(n.title)}"></button>
          ${link}
        </div>
        <div id="${kids}">${treeHTML(n.children, currentPageId)}</div>
      </li>`;
    }
    return `<li class="leaf">${link}</li>`;
  };
  return `<ul class="tree">${nodes.map(item).join('')}</ul>`;
}

// WHAT A NARROW VIEWPORT SHOWS FIRST.
//
// The thing somebody navigated to. That is the whole of the rule, and the
// layout broke it: below about 900px the two columns become one, the sidebar
// is first in the source, and an 82-page tree therefore rendered 4,500 pixels
// of navigation above the page itself. A compliance director, at 420px: "on a
// phone I'd approve without scrolling back up to read anything."
//
// The fix is not to drop the tree — it is the only navigation there is — and
// not to move it below the page, which would put it a document's scroll from
// where a reader looks for navigation. It collapses: at a narrow width the
// sidebar is the collection's name and one button saying how many pages are
// behind it. One tap opens the tree in place.
//
// The button ships hidden and is revealed by `wireSidebar` only where the media
// query matches, so a browser running no JavaScript gets what it always got:
// the whole tree, open, with no control that does nothing.
//
// The New page control is drawn through the refusal group like every other
// control (USER-TESTING.md T4.4): creating a page needs `edit`, and it used to
// be offered to everybody and refused at the click.
function sidebarHTML(collection, tree, currentPageId) {
  const count = flattenTree(tree).length;
  const group = refusalGroup('these controls');
  const newPage = group.offer(
    collection.abilities?.createPage ?? null,
    '+ New page',
    '<button class="btn subtle sidebar-new" id="sidebar-new-page">+ New page</button>',
    { className: 'btn subtle sidebar-new' },
  );
  return `
    <aside class="sidebar" data-refusal-host>
      <a class="sidebar-collection" href="#/collections/${esc(collection.id)}">${esc(collection.name)}</a>
      ${collection.restricted ? restrictedTagHTML() : ''}
      <button class="btn subtle tree-toggle" id="tree-toggle" type="button" hidden
        aria-expanded="true" aria-controls="sidebar-tools"></button>
      <div id="sidebar-tools">
        ${newPage}
        ${/* Collapsed even at one reason. The sidebar is four inches wide and
              the tree is what it is for: a four-line sentence about a button
              somebody is not pressing would push the navigation off the screen,
              which is the stacking complaint in miniature. */ ''}
        ${group.noteHTML({ collapse: true, summary: 'New page is greyed out here.' })}
        <nav class="tree-nav">${treeHTML(tree, currentPageId)}</nav>
      </div>
    </aside>`;
}

/** How the collapsed control reads. The count is the point: it says what is behind it. */
function treeToggleLabel(count, open) {
  if (open) return 'Hide the page list';
  return count === 1 ? 'Show the 1 page in this collection' : `Show the ${count} pages in this collection`;
}

function wireSidebar(collection, tree) {
  app.querySelector('#sidebar-new-page')?.addEventListener('click', () => openNewPageModal(collection, tree));

  const aside = app.querySelector('.sidebar');
  const toggle = app.querySelector('#tree-toggle');
  const tools = app.querySelector('#sidebar-tools');
  if (!aside || !toggle || !tools) return;
  const count = flattenTree(tree).length;

  // The same breakpoint the stylesheet folds the grid at, asked here rather
  // than duplicated as a number: one column is exactly the case where the tree
  // sits on top of the page instead of beside it.
  const narrow = window.matchMedia('(max-width: 900px)');
  // What the reader last asked for at this width. Null means they have not
  // asked, and the default applies; a resize clears it, because a choice made
  // about a phone-shaped screen is not a choice about a desktop one.
  let chosen = null;
  const sync = () => {
    const collapsible = narrow.matches;
    toggle.hidden = !collapsible;
    const open = !collapsible || (chosen ?? false);
    tools.hidden = !open;
    toggle.textContent = treeToggleLabel(count, open);
    toggle.setAttribute('aria-expanded', String(open));
  };
  toggle.addEventListener('click', () => { chosen = tools.hidden; sync(); });
  // A media query outlives the view: every render puts a new sidebar in the
  // page and this listener would otherwise pile up, one per navigation, each
  // holding a sidebar that is no longer in the document. It retires itself the
  // first time it fires after its own sidebar has gone.
  const onWidthChange = () => {
    if (!aside.isConnected) { narrow.removeEventListener('change', onWidthChange); return; }
    chosen = null;
    sync();
  };
  narrow.addEventListener('change', onWidthChange);
  sync();

  // AND THE TREE IS NOT KEPT IN A BOX OF ITS OWN.
  //
  // The sidebar is sticky, and a sticky column has to be told a height, so it
  // was a scroll region: max-height, overflow: auto. On a corpus of any size
  // that is a short window onto a long list — it clipped an entry mid-word, and
  // a page somebody had just created sat below the fold of a box inside a page,
  // which is the one place nobody thinks to look. A reader concluded the page
  // had not been created.
  //
  // So the box is only a box while everything fits in it. Where the tree is
  // taller than the space a sticky column can have, the column stops being
  // sticky and the whole of it scrolls with the page: nothing is clipped,
  // nothing is hidden behind an inner scrollbar, and the last page in the
  // collection is reachable by the gesture the reader is already using.
  const fits = aside.scrollHeight <= window.innerHeight - 96;
  aside.classList.toggle('is-long', !fits);
  // The greyed New page needs no wiring of its own: refusals are delegated on
  // the document, once, at the bottom of this file.
}

// A NEW PAGE IS OWNED FROM THE MOMENT IT EXISTS.
//
// Nine pages in one seeded collection showed "—" under Owner, and nothing had
// ever asked for one: the first anybody heard of it was Submit for review
// refusing the page for want of an owner, days later, on another screen.
//
// The server defaults the owner to the creator (`createPage`, which sets out
// the argument). This dialog ASKS as well, filled in with the creator, because
// a default nobody is shown is a default nobody corrects — and because the
// person who creates a page very often knows it belongs to somebody else.
//
// Who may be named: the collection's own members, the same narrowing the
// approver picker uses. An owner who is not in the collection cannot act on
// the page they are accountable for, and the picker used to offer the whole
// directory. If the membership cannot be read, it falls back to the directory
// rather than to nothing.
async function openNewPageModal(collection, tree, presetParentId = null) {
  const flat = flattenTree(tree);
  await loadActors().catch(() => null);
  let members = null;
  try {
    const rows = await api('GET', `/collections/${collection.id}/members`);
    members = rows.map((m) => ({ id: m.actorId, name: actorName(m.actorId) })).sort((a, b) => a.name.localeCompare(b.name));
  } catch { members = null; }
  const people = members ?? (state.actors ?? []).map((a) => ({ id: a.id, name: a.name }));
  const me = state.actor?.id ?? '';
  const ownerOptions = people.map((p) =>
    `<option value="${esc(p.id)}" ${p.id === me ? 'selected' : ''}>${esc(p.name)}${p.id === me ? ' (you)' : ''}</option>`,
  ).join('');
  // A Note carries no owner (TYPE_RULES), so the field follows the type rather
  // than asking for something the record would then quietly drop.
  const ownerTypes = Object.keys(TYPE_LABELS).filter((t) => (TYPE_FIELDS[t] ?? {}).owner);

  openModal({
    title: `New page in ${collection.name}`,
    submitLabel: 'Create page',
    body: `
      <label>Title <input name="title" required maxlength="200" placeholder="Page title"></label>
      <label>Type
        <select name="type">
          ${Object.keys(TYPE_LABELS).map((t) => `<option value="${t}">${TYPE_LABELS[t]}</option>`).join('')}
        </select>
      </label>
      <p class="muted type-help" data-type-help>${esc(TYPE_HELP.policy)}</p>
      <label data-owner-field>Owner
        <select name="ownerId">${ownerOptions}</select>
      </label>
      <p class="muted type-help" data-owner-help>Who is accountable for this page. It starts as you and
        can be changed here or in the editor at any time; a page with nobody's name on it is the one
        thing the record should never hold.</p>
      <label>Parent page
        <select name="parentId">
          <option value="">(top level)</option>
          ${flat.map((n) => `<option value="${esc(n.id)}" ${n.id === presetParentId ? 'selected' : ''}>${'&nbsp;'.repeat(n.depth * 3)}${esc(n.title)}</option>`).join('')}
        </select>
      </label>`,
    onSubmit: async (form) => {
      const type = form.type.value;
      const page = await api('POST', '/pages', {
        collectionId: collection.id,
        parentId: form.parentId.value || null,
        type,
        title: form.title.value.trim(),
        ...(ownerTypes.includes(type) ? { ownerId: form.ownerId.value || null } : {}),
      });
      toast(`Page "${page.title}" created as a ${TYPE_LABELS[page.type]}.`, 'ok');
      location.hash = `#/pages/${page.id}`;
    },
  });
  const form = document.querySelector('#modal-root form');
  const syncType = () => {
    form.querySelector('[data-type-help]').textContent = TYPE_HELP[form.type.value];
    const wanted = ownerTypes.includes(form.type.value);
    form.querySelector('[data-owner-field]').hidden = !wanted;
    form.querySelector('[data-owner-help]').hidden = !wanted;
  };
  form.type.addEventListener('change', syncType);
  syncType();
}

// ---------------------------------------------------------------------------
// Collection view

// WHAT A COLLECTION OPENS ON.
//
// Its documents. That sentence should not need writing down, and it does:
// clicking a folder used to show a staff permissions table with Remove buttons
// beside every name, while the pages themselves were a side strip whose titles
// were cut after about eighteen characters (USER-TESTING.md T4.6). A new
// contributor's first act in the product was reading a roster she had no
// business in and no use for.
//
// Membership is administration. It is real, it is auditable, and it belongs on
// a screen somebody goes to on purpose — `#/collections/:id/members`, one
// click from here, named on the button. The front page is the contents: every
// page in the collection, in the record's own order, with what a reader needs
// to decide whether to open it — what kind of document it is, whether they may
// rely on it, who owns it, and when it is next due to be looked at.

/** One row per page, in tree order, indented by depth. */
function collectionContentsHTML(tree) {
  const rows = flattenTree(tree).map((n) => {
    const overdue = n.status === 'canonical' && isPastReview(n.reviewDate);
    const review = n.reviewDate
      ? `${fmtDate(n.reviewDate)}${overdue ? ' <span class="muted">· past</span>' : ''}`
      : '<span class="muted">—</span>';
    return `
      <tr class="doc-row doc-d${Math.min(n.depth, 4)}">
        <td class="doc-title"><a href="#/pages/${esc(n.id)}">${esc(n.title)}</a></td>
        <td class="nowrap">${esc(TYPE_LABELS[n.type] ?? n.type)}</td>
        ${/* Supersession beside standing, for the reason the whole table is
              here: this is the screen somebody chooses a page FROM, and a
              chip that says only DRAFT over a page the record has replaced
              sends them into it none the wiser. See supersededChipHTML. */ ''}
        <td class="nowrap">${pageBadge(n, 'sm')} ${supersededChipHTML(n.supersededBy)}</td>
        <td>${n.ownerId ? actorLabel(n.ownerId) : '<span class="muted">—</span>'}</td>
        ${/* For a page In Review this is the approver the server will accept —
              the draft's, the same one the queue is built on — so a queue can
              be checked against this table rather than by opening every page.
              For anything else it is who approved what is published. */ ''}
        <td>${
          n.status === 'in_review'
            ? (n.pendingApproverId ? `${actorLabel(n.pendingApproverId)} <span class="muted">· waiting</span>` : '<span class="muted">any approver</span>')
            : n.approverId ? actorLabel(n.approverId) : '<span class="muted">—</span>'
        }</td>
        <td class="nowrap">${review}</td>
      </tr>`;
  });
  // Six columns, so on a narrow screen it scrolls inside its own container
  // rather than pushing the page sideways and taking the status key with it.
  return `
    <div class="table-scroll">
      <table class="table docs-table">
        <thead><tr><th>Page</th><th>Type</th><th>Status</th><th>Owner</th><th>Approver</th><th>Review due</th></tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table>
    </div>`;
}

async function viewCollection(id) {
  const [collection, tree] = await Promise.all([
    api('GET', `/collections/${id}`),
    api('GET', `/collections/${id}/tree`),
  ]);
  await loadActors().catch(() => null);

  const flat = flattenTree(tree);
  const counts = new Map();
  for (const n of flat) counts.set(n.status, (counts.get(n.status) ?? 0) + 1);
  // Archived pages leave the tree, so they are absent from `flat` and must be
  // counted from the collection itself or the difference stays invisible.
  if (typeof collection.archivedPages === 'number' && collection.archivedPages > 0) {
    counts.set('archived', collection.archivedPages);
  }
  const present = new Set(counts.keys());
  // The tally lists the four live statuses and the tree omits archived pages,
  // so this count and the attestation register's count are about different
  // populations — 82 against 85 in the corpus a compliance director
  // cross-footed. Neither is wrong and neither said so: "I'd guess archived
  // pages, but I'm guessing, and I don't sign things I'm guessing about."
  // Two numbers on an examiner's desk that do not tie, with nothing to explain
  // the difference, is a finding whatever the explanation turns out to be.
  const archived = counts.get('archived') ?? 0;
  const tally = ['canonical', 'needs_update', 'in_review', 'draft']
    .filter((s) => counts.has(s))
    .map((s) => `${counts.get(s)} ${STATUS_LABELS[s]}`)
    .join(' · ')
    + (archived
      ? ` · ${archived} archived, not listed below (the attestation register counts ${flat.length + archived} including them)`
      : '');

  // Same mirror as everywhere else: creating a page needs `edit` here.
  const group = refusalGroup('these actions');
  const newPageHTML = group.offer(
    collection.abilities?.createPage ?? null,
    'New page',
    '<button class="btn primary" id="main-new-page">New page</button>',
    { className: 'btn primary' },
  );

  app.innerHTML = `
    <div class="layout">
      ${sidebarHTML(collection, tree, null)}
      <section class="main">
        <div class="page-head">
          <div>
            <h1>${esc(collection.name)}
              ${collection.restricted ? restrictedTagHTML() : ''}</h1>
            <p class="muted">${esc(collection.description || 'No description.')}</p>
          </div>
          <div class="actions">
            <span id="attestation-affordance"></span>
            <span id="map-affordance"></span>
            <span id="ask-affordance"></span>
            <a class="btn subtle" href="#/collections/${esc(collection.id)}/members">Members</a>
            ${newPageHTML}
          </div>
        </div>
        ${group.noteHTML()}

        ${tree.length ? `
          <section class="panel">
            <h2 class="h-small">Contents — ${flat.length} page${flat.length === 1 ? '' : 's'}</h2>
            ${tally ? `<p class="muted docs-tally">${esc(tally)}</p>` : ''}
            ${collectionContentsHTML(tree)}
          </section>

          <section class="panel">
            <h2 class="h-small">What the statuses mean</h2>
            <p class="muted">Every page in Canon carries one. It is the record's own answer to whether
              you may act on what the page says.</p>
            ${statusKeyHTML(present)}
          </section>` : `
          <div class="empty-state">
            <h2>No pages yet</h2>
            <p>Pages are the unit of knowledge in Canon. Start with a Note for working
            material, or a Policy, Spec, or Plan when there is an owner ready to stand
            behind it.</p>
          </div>`}
      </section>
    </div>`;

  wireSidebar(collection, tree);
  app.querySelector('#main-new-page')?.addEventListener('click', () => openNewPageModal(collection, tree));
  renderMapAffordance('map-affordance', collection.id);
  renderAskAffordance('ask-affordance', collection.id);
  renderAttestationAffordance('attestation-affordance', {
    kind: 'collection',
    id: collection.id,
    title: collection.name,
  });
}

// ---------------------------------------------------------------------------
// Collection members — the administration screen the front page used to be
//
// THE LAST SCREEN THAT OFFERED WHAT IT WOULD REFUSE, and the one where a wrong
// click would be most alarming. Holding only `edit`, a contributor was shown a
// fully enabled **Remove** beside every colleague's name and a live Add member
// form; pressing Remove produced a three-second toast in the far corner reading
// "Requires admin access to this collection", and nothing happened. She could
// not tell whether she had removed somebody.
//
// It is the page view's treatment, from the same source: the server says who
// may administer membership here (`collection.abilities`, a mirror of
// `requirePermissionAdmin` and never a gate), the controls it would refuse are
// greyed and carry its sentence, and the sentence names the collection, what
// she holds, and who can.

async function viewCollectionMembers(id) {
  const [collection, tree] = await Promise.all([
    api('GET', `/collections/${id}`),
    api('GET', `/collections/${id}/tree`),
  ]);
  await loadActors().catch(() => null);
  let members = [];
  try { members = await api('GET', `/collections/${id}/members`); } catch { /* view-only edge */ }

  // Absent on a server older than this screen, in which case every control is
  // offered exactly as it was before — nothing here turns an offer ON.
  const can = collection.abilities ?? null;
  const group = refusalGroup('these controls');
  const removeAbility = can?.removeMember ?? null;
  const addAbility = can?.addMember ?? null;

  app.innerHTML = `
    <div class="layout">
      ${sidebarHTML(collection, tree, null)}
      <section class="main">
        <p class="breadcrumb"><a href="#/collections/${esc(collection.id)}">${esc(collection.name)}</a></p>
        <div class="page-head">
          <div>
            <h1>Members of ${esc(collection.name)}</h1>
            <p class="muted">Who may read this collection, who may write in it, and who may grant the
              Canonical mark. Granting and withdrawing here is administration and is audited; a role a
              directory group grants cannot be withdrawn from this screen, and Canon says so when you try.</p>
          </div>
        </div>

        <section class="panel">
          <h2 class="h-small">Members</h2>
          ${members.length ? `
            <table class="table">
              <thead><tr><th>Member</th><th>Role</th><th></th></tr></thead>
              <tbody>
                ${members.map((m) => `
                  <tr>
                    <td>${actorLabel(m.actorId)}</td>
                    <td><span class="role-tag">${esc(m.role)}</span></td>
                    <td class="t-right">${group.offer(
                      removeAbility,
                      'Remove',
                      `<button class="btn subtle" data-remove-member="${esc(m.actorId)}">Remove</button>`,
                      { className: 'btn subtle' },
                    )}</td>
                  </tr>`).join('')}
              </tbody>
            </table>` : '<p class="muted">Membership is not visible to you.</p>'}
          ${/* The form goes with the buttons. A live "Add member" beside a row
                of greyed Removes would be the same defect wearing the other
                half of the screen, so its fields are disabled too and the
                submit carries the same sentence. */ ''}
          <form id="add-member-form" class="inline-form">
            <select name="actorId" required ${addAbility?.can === false ? 'disabled' : ''}>
              <option value="">Add member…</option>
              ${(state.actors ?? []).filter((a) => !members.some((m) => m.actorId === a.id))
                .map((a) => `<option value="${esc(a.id)}">${esc(a.name)}${a.kind === 'agent' ? ' (agent)' : ''}</option>`).join('')}
            </select>
            <select name="role" ${addAbility?.can === false ? 'disabled' : ''}>
              ${ROLES.map((r) => `<option value="${r}" ${r === 'view' ? 'selected' : ''}>${r}</option>`).join('')}
            </select>
            ${group.offer(addAbility, 'Add', '<button class="btn" type="submit">Add</button>')}
          </form>
          ${group.noteHTML()}
        </section>
      </section>
    </div>`;

  wireSidebar(collection, tree);
  app.querySelector('#add-member-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    if (!form.actorId.value) return;
    try {
      await api('PUT', `/collections/${id}/members/${form.actorId.value}`, { role: form.role.value });
      toast('Member added.', 'ok');
      route();
    } catch (err) { toastError(err); }
  });
  app.querySelectorAll('[data-remove-member]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        // The answer says what is LEFT. A directory group can still be granting
        // this person a role here (SECURITY.md R10), and "Member removed."
        // would then be a lie the reader only discovers later.
        const left = await api('DELETE', `/collections/${id}/members/${btn.dataset.removeMember}`);
        if (left && left.removed === false && left.remaining) {
          const groups = (left.groups || []).map((g) => g.group).join(', ');
          toast(
            `Your grant is withdrawn, but they still hold ${left.remaining} here` +
              (groups ? ` through ${groups}` : ' through a directory group'),
            'warn',
          );
        } else {
          toast('Member removed.', 'ok');
        }
        route();
      } catch (err) { toastError(err); }
    });
  });
}

// ---------------------------------------------------------------------------
// Page view
//
// WHICH APPROVER THIS SCREEN NAMES, and why it is not obvious.
//
// A page carries its owner, approver and dates in two places. The page row
// carries the PUBLISHED version's — history, and meant to be historical: what
// this policy said and who was accountable for it on the date somebody is
// asking about. The draft under review carries what is being PROPOSED. They
// differ exactly when somebody changes the approver, which is the interesting
// case and was the broken one: the header read the page row while the Approve
// button posted to a server that enforces the draft's, so a page could show
// "APPROVER: Grace Abara" beside a green Approve button that only Nadia Haddad
// could press (USER-TESTING.md T1.3).
//
// The server settles it — `approve` enforces the draft's, because approving is
// what publishes that draft — and `GET /pages/:id` now carries `review`, the
// one answer for a page In Review. The rule here follows from that:
//
//   THE PERSON NAMED ON SCREEN IS THE PERSON THE SERVER WILL ACCEPT, AND
//   NOBODY ELSE. Anything that names an approver while a page is in review
//   reads `page.review.approverId`. `page.approverId` answers a different
//   question — "who approved what is published" — and is right everywhere
//   else.
//
// The second half is the empty header on a first submission. A page that has
// never published has nulls in its page row, so owner, approver and both dates
// rendered "—" while the draft plainly carried all four. It is fixed by
// showing the pending values only where there is no published version to
// protect; a published page still shows what it published, with the pending
// value named beside it rather than in place of it.

// One field's cell. `published` is the page row's value, `pending` the draft's
// (undefined when nothing is pending), `render` turns either into safe HTML.
//
// Two markers rather than one, because they mark different things. "proposed"
// means there is nothing published to compare against: the value is real, it
// is the draft's, and it is not yet a fact about the record. "in review: X"
// means the page has published a value and a different one is pending — both
// belong on screen, and neither may be shown as the other.
function pendingFieldCell(published, pending, render, hasPublished) {
  if (!hasPublished) {
    const value = pending === undefined ? published : pending;
    if (value == null) return '—';
    return `${render(value)} <span class="muted">· proposed</span>`;
  }
  if (pending === undefined || (pending ?? null) === (published ?? null)) return render(published);
  return `${render(published)} <span class="muted">· in review: ${render(pending)}</span>`;
}

// The structured fields an approval publishes alongside the body. The field
// block already marks a pending change in place; these are gathered again where
// the DECISION is taken, because "the approver changed" and "the effective date
// moved" are exactly the kind of material change that got lost in a header.
//
// Each `render` receives the FLATTENED value (see flatField): a list arrives
// as its names joined, so one render vocabulary covers scalar and list fields
// alike and a change to either reads as one line.
const REVIEW_FIELDS = [
  { key: 'ownerId', label: 'Owner', render: (v) => (v == null ? '<span class="muted">none</span>' : actorLabel(v)) },
  { key: 'approverId', label: 'Approver', render: (v) => (v == null ? '<span class="muted">none</span>' : actorLabel(v)) },
  { key: 'effectiveDate', label: 'Effective date', render: (v) => esc(fmtDate(v)) },
  // The approver is deciding on the date AND on the reason given for it. A
  // backdated date is only supportable because somebody stated where it came
  // from, so a change to that statement is a change to the evidence and belongs
  // in front of whoever is about to put their name to it.
  {
    key: 'effectiveDateBasis',
    label: 'Basis for the effective date',
    render: (v) => (v == null || v === '' ? '<span class="muted">none stated</span>' : esc(v)),
  },
  { key: 'reviewDate', label: 'Review date', render: (v) => esc(fmtDate(v)) },
  // Aliases steer which questions land on this page, which is precisely why
  // they go through review at all — and a vocabulary change was the change an
  // approver signed without ever being shown (third round, finding 1).
  {
    key: 'aliases',
    label: 'Also known as',
    render: (v) => (v == null ? '<span class="muted">none</span>' : esc(v)),
  },
];

// One field value, flattened the way the attestation's field history flattens
// it: a list is its names joined, an empty list is no value at all. Fields are
// compared flattened, because comparing an array by identity would report
// every render as a change and comparing it by nothing would report none.
function flatField(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.length ? value.join(', ') : null;
  return value;
}

// The changed-field rows between two field sets, in REVIEW_FIELDS' vocabulary.
// One function shared by the review panel and the version compare, so the two
// surfaces can never disagree about what counts as a field change. `hasBase`
// false leaves `from` null — there was no baseline to change from, and the row
// renders as the value being introduced rather than as a change.
function changedFieldRows(baseFields, proposedFields, hasBase) {
  return REVIEW_FIELDS.map((f) => ({
    f,
    from: flatField(baseFields[f.key] ?? null),
    to: flatField(proposedFields[f.key] ?? null),
  }))
    .filter((x) => x.from !== x.to)
    .map((x) => ({
      label: x.f.label,
      from: hasBase ? x.f.render(x.from) : null,
      to: x.f.render(x.to),
    }));
}

// What this draft would change if it were approved: the body diff, the title,
// and the fields. Computed once per render, because the panel below and the
// Approve modal must not be able to disagree about it.
//
// THE BASELINE IS THE LAST VERSION TO HOLD THE CANONICAL MARK, never merely
// the last version to publish. Publishing moves the current version with no
// approver's name on the move, so on a page that was edited, published and
// re-drafted, a current-version baseline already contains unreviewed changes —
// and a diff against it presents exactly those changes as background, which is
// how an approver was made to certify vocabulary this panel never showed her
// (third round, finding 1). The server names the marked version
// (`page.lastCanonical`, from the approval events); a server too old to name
// one leaves the key absent, and the current version is then the only baseline
// on offer — the sentence below says which of the two it is stating.
function summarizeChange(page, draft) {
  const baselineIsMarked = 'lastCanonical' in page;
  const baseline = baselineIsMarked ? page.lastCanonical : (page.current ?? null);
  const rows = diffLines(baseline?.body ?? '', draft.body ?? '');
  const proposed = draft.fields ?? {};
  return {
    hasBaseline: Boolean(baseline),
    hasPublished: Boolean(page.current),
    baselineIsMarked,
    // The text itself, for the case where there is nothing to diff it against.
    // With no baseline the page below the panel is an empty state or the
    // unreviewed published text — and an approver reading a panel that says
    // "the whole of it is new" must be shown the whole of it, not pointed at
    // an invitation to write the page they were about to approve.
    proposedBody: draft.body ?? '',
    baseVersion: baseline?.number ?? null,
    nextVersion: (page.currentVersion ?? 0) + 1,
    rows,
    changed: baseline ? changedLines(rows) : null,
    titleFrom: baseline ? baseline.title : null,
    titleTo: draft.title ?? page.title,
    titleChanged: Boolean(baseline) && baseline.title !== (draft.title ?? page.title),
    fields: changedFieldRows(baseline?.fields ?? {}, proposed, Boolean(baseline)),
    // What this approval will NOT freeze (see federatedScopeHTML). The
    // descriptors ride inside the page payload, so this costs no call.
    references: Array.isArray(page.references) ? page.references : [],
  };
}

// WHAT AN APPROVAL COVERS, AND WHAT IT CANNOT.
//
// A federated value is not in the version. Canon holds a reference and asks the
// source for the value every time the page is read (DATA-BACKBONE.md §6), so a
// page approved this morning can show a different number this afternoon —
// without a new version, without an approval, and without the approver hearing
// about it. That is the design and it is the right design: Canon does not copy
// facts it does not own.
//
// It was disclosed in exactly one place, the editor: "they are page-level and
// take effect immediately — they are not part of this draft". The compliance
// director praising the provenance line on HEADCOUNT (ENGINEERING) — 41 —
// service-resolved — People System · resolved 30 minutes ago — was reading it
// as a reader. As an APPROVER he was never told, and he is the one person for
// whom it changes what his signature means. His words for what he wanted:
// *your approval covers the text; this value is live.*
//
// So the panel where the decision is taken says it, in front of the diff rather
// than after it, and the Approve modal restates the count. It is not a warning
// and it is not phrased as one: the value being live is why it is worth having.
// What is wrong is an approver who does not know.
function federatedScopeHTML(references, nextVersion) {
  if (!references.length) return '';
  const rows = references.map((raw) => {
    const r = normalizeReference(raw);
    const service = r.authMode === 'service';
    return `<li><span class="review-fed-label">${esc(referenceLabel(r))}</span>
      <span class="muted">${esc(clip(r.sourceName || r.sourceId || 'unknown source', 48))}${
        service ? ' · service-resolved' : ''
      }</span></li>`;
  });
  const one = references.length === 1;
  return `
    <div class="review-fed">
      <h3 class="review-fed-head">${one ? 'One value on this page is live' : `${references.length} values on this page are live`}</h3>
      <p>Approving publishes the text as v${nextVersion}. It does not fix ${one ? 'this value' : 'these values'}:
        Canon stores ${one ? 'it' : 'them'} nowhere and asks ${one ? 'its source' : 'their sources'} again every
        time somebody reads the page. ${one ? 'It is' : 'They are'} page-level and live, so
        ${one ? 'it' : 'they'} can read differently tomorrow — no new version, no approval, and nothing that
        would come back to you. <strong>Your approval covers the text.</strong></p>
      <ul class="review-fed-list">${rows.join('')}</ul>
      <p class="muted">Where the value comes from, when it was last resolved and whether a second system disagrees
        are on the page beside it. Adding or removing one is an edit to the page, not part of any review.</p>
    </div>`;
}

// One sentence for the extent of a change, used in the panel and again in the
// modal so both say the same number — and it names the baseline, because
// "changed since WHAT" is the half of a diff a reader cannot check for
// themselves, and an unstated baseline is filled in with the wrong one.
function changeSentence(change) {
  if (!change.hasBaseline) {
    // Two different absences, and only one of them is innocent: a page that
    // never published has nothing to compare against, while a page that
    // published without review has a current version the mark never covered —
    // saying "nothing has been published" there would hide exactly the text
    // the approver most needs to read whole.
    return change.hasPublished
      ? 'No version of this page has ever held the Canonical mark, so all of it is new to review.'
      : 'Nothing has been published yet, so all of it is new.';
  }
  const body = change.changed
    ? `${change.changed} changed line${change.changed === 1 ? '' : 's'}`
    : 'no change to the body';
  // The approver handoff is named, not counted. Counting it made this banner
  // say "2 changed fields" where the version compare — which reads published
  // versions, and the handoff lives in the draft — said one, and both were
  // defensible while the pair read as a contradiction (fourth round, Lena).
  // "A new approver" says what the second change IS; the row below still
  // names the person.
  const handoff = change.fields.some((f) => f.label === 'Approver');
  const counted = change.fields.length - (handoff ? 1 : 0);
  const fields = counted ? `, and ${counted} changed field${counted === 1 ? '' : 's'}` : '';
  const approver = handoff ? ', and a new approver' : '';
  const since = change.baselineIsMarked
    ? `since v${change.baseVersion}, the last version to hold the Canonical mark`
    : `against the published v${change.baseVersion}`;
  return `${body[0].toUpperCase()}${body.slice(1)}${fields}${approver} ${since}.`;
}

// The changed-field rows, drawn one way wherever field changes are shown —
// the review panel and the version compare — because a field change that
// renders differently on two screens invites a reader to believe they are two
// different changes.
function fieldRowsHTML(fields) {
  if (!fields.length) return '';
  return `<ul class="review-change-fields">${fields
    .map((f) => `<li><span class="review-change-field">${esc(f.label)}</span>
      ${f.from === null ? f.to : `<del>${f.from}</del> → <ins>${f.to}</ins>`}</li>`)
    .join('')}</ul>`;
}

// USER-TESTING.md T4.2 — THE DIFF BELONGS ON THIS SIDE OF THE DECISION.
//
// "I approved blind. The page body shows the published version; there's no
// preview or diff of the pending draft. The excellent side-by-side diff is only
// reachable AFTER approval, via History. The change added a whole section about
// a missing escalation path. Material, and unseen."
//
// Nothing here is new machinery. It is `diffLines` and `diffTableHTML`, the
// same two functions the compare view uses, against the published version the
// draft would replace — moved to where somebody is standing when they press
// Approve, and above the published body rather than below it, because the
// published body is the one thing on this screen that is NOT what is being
// decided.
//
// It is drawn for anyone who can read the draft, not only for the approver:
// the author wants to see what they submitted, and a second approver deciding
// whether to send it back needs it just as much. A reader holding only `view`
// cannot fetch the draft body and gets nothing, which is the same rule as
// everywhere else and not a special case here.
function reviewChangeHTML(change) {
  if (!change) return '';
  const fields = fieldRowsHTML(change.fields);
  const title = change.titleChanged
    ? `<p class="review-change-title">Title: <del>${esc(change.titleFrom)}</del> → <ins>${esc(change.titleTo)}</ins></p>`
    : '';
  const body = !change.hasBaseline
    ? `<p class="muted">${change.hasPublished
         ? `No version of this page has ever held the Canonical mark, so there is no reviewed baseline to
            compare against: what follows is the whole of what approving as v${change.nextVersion} certifies,
            including everything already published without review.`
         : `Nothing has been published on this page yet, so there is nothing to compare against:
            this is the whole of it, and approving publishes it as v${change.nextVersion}.`}</p>
       ${change.proposedBody.trim()
         ? `<article class="doc-body review-proposed">${renderMarkdown(change.proposedBody)}</article>`
         : '<p class="muted">The draft has no body text.</p>'}`
    : change.changed
      ? diffTableHTML(
          change.rows,
          // The left column says what it IS. "Published vN" was true only by
          // coincidence: the baseline is the last version to hold the mark,
          // which is not always the version currently published.
          change.baselineIsMarked ? `Canonical v${change.baseVersion}` : `Published v${change.baseVersion}`,
          `Proposed v${change.nextVersion}`,
        )
      : '<p class="muted">The body is unchanged.</p>';
  return `
    <section class="panel review-change" id="review-change">
      <h2 class="h-small">What is being approved</h2>
      <p class="muted">${esc(changeSentence(change))} Approving publishes exactly this, as
        v${change.nextVersion}.</p>
      ${/* Before the diff, not after it: the extent of an approval is part of
            reading the diff, and an approver who has scrolled a hundred lines
            of text has already decided by the time they reach a footnote. */ ''}
      ${federatedScopeHTML(change.references, change.nextVersion)}
      ${title}
      ${fields}
      ${body}
    </section>`;
}

// USER-TESTING.md T4.3 — the approver's refusal, in front of the author.
//
// It went to the outbox and to the audit log and to nowhere the author would
// look: they saw a Draft with a green Submit button, no banner, no reason and
// no rejector. The text is now a comment on the page as well (store.ts,
// `sendBack`), and this is the banner that puts it at the top: who sent it
// back, when, and what they said, in their words and in full.
//
// Shown to everyone who can read the page, not only to the author: "why is this
// a Draft rather than Canonical" is a fact about the page.
function sentBackNoticeHTML(sentBack) {
  if (!sentBack) return '';
  return `
    <div class="notice notice-sentback">
      <div><strong>${esc(actorName(sentBack.byId))}</strong> sent this back${
        sentBack.at ? ` on ${fmtDateTime(sentBack.at)}` : ''
      }. It is back out of review — edit it and submit it again when it is ready.</div>
      ${sentBack.reason ? `<blockquote class="sentback-reason">${esc(sentBack.reason)}</blockquote>` : ''}
      ${sentBack.commentId
        ? `<div class="muted">It is on the page as a comment too, where it can be replied to and resolved.
           <button class="btn subtle" id="goto-sentback-comment">Show it in comments</button></div>`
        : ''}
    </div>`;
}

// ---------------------------------------------------------------------------
// A PAGE'S STANDING GOES WHERE A READER MEETS THE PAGE.
//
// "Somebody who reads the top of the page and stops never learns the number is
// contested. 'This is out of date' and 'this number is disputed' belong in the
// same place, and it isn't the basement." — a compliance director, second round
// of user testing, on the Records Retention Schedule: its second sentence says
// claims records are kept for seven years, a person has written down that the
// platform spec contradicts it, and that assertion was rendered below the body,
// below the federated values, below everything — while "past review" got a
// banner above the fold.
//
// The answer path had already learned this lesson: a citation carries
// `disputed` and reads "contested" beside the page's own badge, because a
// page's standing must not depend on how somebody phrased a question
// (answers.ts, `disputedAmong`). It must not depend on how far somebody
// scrolled either. So every reason to hesitate over this page — it is
// archived, it is past its review date, a person says it contradicts another
// page, a person says another page replaced it — is one list, drawn in one
// place, at the top.
//
// This is NOT a move of the Conflicts and supersessions panel. The panel is
// the register: every relation at both ends, with Withdraw and Assert, and the
// two-sided detail. What moves up is the STANDING — the fact, its author, their
// reasoning and the date — and the notice points down to the panel for the
// rest. Saying it twice is the right amount for something a reader must not be
// able to miss.
//
// The notes are computed as data rather than as HTML so the ordering rule can
// be asserted without a DOM (test/pageview.test.ts).
function pageStandingNotes(page, relations) {
  const notes = [];
  if (page.status === 'archived') notes.push({ kind: 'archived' });
  if (page.status === 'needs_update') notes.push({ kind: 'needs_update' });
  // Read from the DATE, not from the status: a Canonical page whose review date
  // passed since the last sweep is already stale (USER-TESTING.md T1.4).
  if (page.status === 'canonical' && isPastReview(page.reviewDate)) notes.push({ kind: 'overdue' });
  for (const rel of relations ?? []) {
    // Both ends of a conflict are contested, because the assertion is that the
    // two pages cannot both be right and it names no favourite.
    if (rel.reads === 'conflicts_with') notes.push({ kind: 'contested', relation: rel });
    // `superseded_by` is a caution about THIS page; `supersedes` is not — it
    // says something about the other one, and belongs in the panel with the
    // rest of the register rather than in a banner warning a reader off a page
    // that is perfectly good.
    if (rel.reads === 'superseded_by') notes.push({ kind: 'superseded', relation: rel });
  }
  return notes;
}

/** The other page in a relation, as a link where the reader may open it. */
function standingTargetHTML(rel) {
  // Withheld: no link, no title, no status. The banner still fires — that a
  // page is contested is a fact about THIS page, and the reader is standing on
  // it. What they are not told is which page it is contested with.
  if (rel.withheld) return `<span class="rel-target-withheld">${esc(WITHHELD_TARGET)}</span>`;
  const title = esc(rel.other.title);
  const badgeHTML = rel.other.status ? ` ${badge(rel.other.status, 'sm')}` : '';
  return rel.other.id ? `<a href="#/pages/${esc(rel.other.id)}">${title}</a>${badgeHTML}` : `${title}${badgeHTML}`;
}

/**
 * The reason line under a standing banner.
 *
 * Three cases, and only one of them is "nobody wrote a reason". A withheld
 * relation HAS a note; it is being kept back because it describes the page the
 * reader may not see. Rendering the "no reason was recorded" line there would
 * be a false statement about the record, which is the one thing this product
 * cannot afford to make.
 */
function standingReasonHTML(rel) {
  if (rel.withheld) {
    return `<p class="muted standing-reason-none">The reason recorded with this assertion describes that page,
      so it is not shown here.</p>`;
  }
  if (rel.note) return `<blockquote class="standing-reason">${esc(rel.note)}</blockquote>`;
  return '<p class="muted standing-reason-none">No reason was recorded with the assertion.</p>';
}

/** Who asserted it and when, with the way down to the whole register. */
function standingAttributionHTML(rel) {
  const when = rel.assertedAt ? ` on ${fmtDateTime(rel.assertedAt)}` : '';
  return `<div class="muted standing-meta">Asserted by ${actorLabel(rel.assertedBy)}${when}.
    <button class="btn subtle" type="button" data-scroll-to="relations-panel">Show it with the others</button></div>`;
}

function standingNoticeHTML(note, page) {
  if (note.kind === 'archived') {
    return '<div class="notice">This page is archived and read-only. It is preserved with its full history.</div>';
  }
  if (note.kind === 'needs_update') {
    return `<div class="notice notice-stale">Past review. Its review date (${fmtDate(page.reviewDate)}) has passed,
      so it is marked Needs Update. It is still the official record and can still be cited — edit it, set a new review
      date, and submit it for review to return it to Canonical.</div>`;
  }
  if (note.kind === 'overdue') return overdueNoticeHTML(page);
  const rel = note.relation;
  if (note.kind === 'contested') {
    return `
      <div class="notice notice-contested">
        <div><strong>Contested.</strong> A person has recorded that this page and ${standingTargetHTML(rel)}
          contradict each other. Both are still the record and both may still be cited: Canon draws a contradiction
          and does not settle it, so what this page says about the disputed point is not agreed.</div>
        ${standingReasonHTML(rel)}
        ${standingAttributionHTML(rel)}
      </div>`;
  }
  return `
    <div class="notice notice-contested">
      <div><strong>Superseded.</strong> A person has recorded that ${standingTargetHTML(rel)} replaces this page.
        Saying so archives nothing: this page keeps its standing, its text and its history, and the page named is
        where that person says the current answer is.</div>
      ${standingReasonHTML(rel)}
      ${standingAttributionHTML(rel)}
    </div>`;
}

function pageStandingHTML(page, relations) {
  return pageStandingNotes(page, relations).map((n) => standingNoticeHTML(n, page)).join('');
}

function reviewBannerHTML(review, typeNamesApprover) {
  // No `review` means a server older than this page, or a draft that has gone
  // missing under review. Say only what is still true rather than naming
  // somebody from the page row, which is the mistake this whole section is
  // about.
  if (!review) return '<div class="notice">In review.</div>';
  const namesApprover = review.namesApprover ?? typeNamesApprover;
  let waiting;
  if (!namesApprover) waiting = 'Waiting on an approver for this collection.';
  else if (review.approverId) {
    waiting = `Waiting on the named approver, <strong>${esc(actorName(review.approverId))}</strong>.`;
  } else waiting = 'Waiting on an approver: this draft names none.';
  const submitted = review.submittedById
    ? ` Submitted by ${actorLabel(review.submittedById)}${
        review.submittedAt ? ` on ${fmtDateTime(review.submittedAt)}` : ''
      }.`
    : '';
  return `<div class="notice">In review. ${waiting}${submitted}</div>`;
}

async function viewPage(id) {
  const page = await api('GET', `/pages/${id}`);
  const [collection, tree, , , relations] = await Promise.all([
    api('GET', `/collections/${page.collectionId}`),
    api('GET', `/collections/${page.collectionId}/tree`),
    loadActors().catch(() => null),
    // Awaited, not fired and forgotten: the page's own overdue notice says
    // something different depending on whether this deployment sweeps, and a
    // notice that changes its mind a moment after paint is worse than either.
    detectFreshness().catch(() => null),
    // The relations, in hand BEFORE the first paint, because part of this
    // page's standing is made of them and standing is drawn at the top. The
    // panel used to be the only reader of this call and could afford to arrive
    // late; a banner that says "contested" cannot appear a second after
    // somebody has read the first paragraph and moved on. Still
    // feature-detected: a Canon that does not serve relations draws no banner
    // and no panel, exactly as before.
    loadRelations(id),
  ]);
  let draft = null;
  try {
    const d = await api('GET', `/pages/${id}/draft`);
    draft = d && d.pageId ? d : null;
  } catch { /* viewers without edit access */ }

  const current = page.current;
  const references = Array.isArray(page.references) ? page.references : [];
  const rules = TYPE_FIELDS[page.type] ?? {};
  const reviewed = REVIEWED_TYPES.includes(page.type);
  const isArchived = page.status === 'archived';
  const inReview = page.status === 'in_review';
  // The pending answer (see the note above this function). While a page is in
  // review it comes from the server, so a reader holding only `view` still
  // sees the right name; before a first publish, an editor's own draft fills
  // the header that would otherwise be a row of dashes.
  const review = page.review ?? null;
  const pendingFields = review?.fields ?? (!current && draft ? draft.fields : null);
  const pendingOf = (key) => (pendingFields ? pendingFields[key] ?? null : undefined);
  const hasPublished = Boolean(current);
  const isApprover = Boolean(review && review.namesApprover && review.approverId === state.actor.id);
  // What the server says this actor may do here (USER-TESTING.md T4.4). Absent
  // on a server older than this page, in which case every action falls back to
  // what it offered before — nothing below turns an offer ON that the old code
  // withheld.
  const can = page.abilities ?? null;
  const ability = (name, fallback) => can?.[name] ?? fallback ?? { can: true, why: null };
  // The diff of the draft under review against what it would replace (T4.2).
  const change = inReview && draft ? summarizeChange(page, draft) : null;

  // The page lock, but not while the page is In Review: nobody is editing it
  // then — the review is what holds it, the banner below says so and names who
  // it is waiting on, and "being edited by Marc Ellis" beside that is a second
  // explanation that is not the true one.
  const draftBanner = draft && !inReview ? `
    <div class="notice ${draft.editorId === state.actor.id ? 'notice-mine' : 'notice-locked'}">
      ${draft.editorId === state.actor.id
        ? `You have a draft in progress (last saved ${fmtDateTime(draft.updatedAt)}).
           <a class="btn subtle" href="#/pages/${esc(id)}/edit">Resume editing</a>`
        : `This page is being edited by <strong>${esc(actorName(draft.editorId))}</strong>. Canon keeps drafts to one editor at a time.`}
    </div>` : '';

  // USER-TESTING.md T4.4: "Every action is offered then refused." An action the
  // server would refuse is GREYED and carries the server's own sentence, and
  // that sentence is in the document as text — a `title` attribute is invisible
  // to a keyboard and to a phone, and "who can do this instead" is the half of
  // the answer that was missing.
  //
  // The group is the shared one (see `refusalGroup`): the same greying, the
  // same sentence, and the same collapse when more than one action is refused,
  // as the Members screen, the source register and the relation dialog. Three
  // or four of these used to be a paragraph of apology above the thing somebody
  // opened the page to read.
  //
  // What is NOT done here: deciding anything. Every one of these is
  // `page.abilities`, which store.ts computes beside the checks it mirrors, and
  // the button being enabled has never been what makes the act legal.
  const group = refusalGroup('these actions');
  const offer = (ability, label, enabledHTML) => group.offer(ability, label, enabledHTML);

  const actions = ['<span id="attestation-affordance"></span>', '<span id="ask-affordance"></span>'];
  if (!isArchived && !inReview) {
    actions.push(offer(ability('edit'), 'Edit', `<a class="btn" href="#/pages/${esc(id)}/edit">Edit</a>`));
  }
  actions.push(`<a class="btn" href="#/pages/${esc(id)}/history">History</a>`);
  // Needs Update submits like a Draft: the way back to Canonical is the review
  // workflow, not a separate re-certify button (FEATURES.md §3). And a
  // CANONICAL page with a draft submits too — the draft goes to review while
  // the approved version keeps serving, which is the road that costs no Ask
  // downtime (finding 8). Offered wherever there is a draft to submit —
  // including where it is not yet ready, which is the case somebody most
  // needs the reason for.
  if (reviewed && page.status !== 'in_review' && !isArchived && draft) {
    actions.push(
      offer(ability('submit'), 'Submit for review', '<button class="btn primary" id="act-submit">Submit for review</button>'),
    );
  }
  if (inReview) {
    // Offered to the one person the server will accept, and to nobody else.
    // Where the type names an approver, a green Approve button in anybody
    // else's hands is the same wrong claim the header used to make (T1.3). The
    // fallback keeps that fix on a server that serves no abilities.
    const approve = ability(
      'approve',
      review && review.namesApprover && !isApprover
        ? { can: false, why: `Only ${actorName(review.approverId)}, the named approver, can approve this.` }
        : null,
    );
    actions.push(offer(approve, 'Approve', '<button class="btn primary" id="act-approve">Approve</button>'));
    actions.push(offer(ability('sendBack'), 'Send back', '<button class="btn" id="act-sendback">Send back</button>'));
    // The author's way out of a submission nobody has acted on yet
    // (USER-TESTING.md T4.5). Offered only where the server will accept it, and
    // hidden rather than greyed everywhere else: it is not an act anybody but
    // its author has any business being shown.
    if (can ? can.withdraw.can : review?.canWithdraw) {
      actions.push('<button class="btn" id="act-withdraw">Withdraw submission</button>');
    }
  }
  if (!isArchived) {
    actions.push(offer(ability('archive'), 'Archive', '<button class="btn subtle" id="act-archive">Archive</button>'));
  }
  // Somebody holding `view` on a page in review is refused three separate
  // things. One reason is one line; three become one line and a "Why?", so the
  // page opens on the page rather than on an apology for it.
  const refusalNote = group.noteHTML();
  // AND SOMETHING TO DO ABOUT IT. The wall already named who holds the role;
  // two testers asked why it could not ask them. It is offered only where the
  // reader holds a role here — a refusal about a collection you hold nothing
  // in gives you no context to carry, and access.ts refuses that ground rather
  // than turning the request endpoint into a place to type ids (policy
  // question 1). `admin` is the top of the ladder, so there is nothing above
  // it to ask for.
  const askAccess = group.count && can?.role && can.role !== 'admin'
    ? `<span class="ask-access-slot"><button type="button" class="btn subtle ask-access" data-ask-access
         data-ground="collection" data-collection="${esc(collection.id)}"
         data-collection-name="${esc(collection.name)}" data-held="${esc(can.role)}">Ask for access</button></span>`
    : '';

  app.innerHTML = `
    <div class="layout">
      ${sidebarHTML(collection, tree, id)}
      <section class="main">
        <p class="breadcrumb"><a href="#/collections/${esc(collection.id)}">${esc(collection.name)}</a></p>
        <div class="page-head">
          <h1 class="doc-title">${esc(page.title)} ${pageBadge(page)}</h1>
          <div class="actions">${actions.join('')}</div>
        </div>
        ${refusalNote}${askAccess}
        ${sentBackNoticeHTML(page.sentBack)}
        ${draftBanner}
        ${/* Everything this page's standing consists of, in one block, before
              the body: archived, past review, contested, superseded. See
              pageStandingNotes. */ ''}
        ${pageStandingHTML(page, relations)}
        ${inReview ? reviewBannerHTML(review, Boolean(rules.approver)) : ''}
        ${reviewChangeHTML(change)}

        <dl class="field-block">
          <div><dt>Type</dt><dd>${esc(TYPE_LABELS[page.type] ?? page.type)}</dd></div>
          ${Array.isArray(page.aliases) && page.aliases.length ? `<div><dt>Also known as</dt><dd>${page.aliases.map((a) => esc(a)).join(', ')}</dd></div>` : ''}
          <div><dt>Status</dt><dd>${pageBadge(page)}</dd></div>
          ${rules.owner || page.ownerId ? `<div><dt>Owner</dt><dd>${pendingFieldCell(page.ownerId, pendingOf('ownerId'), actorLabel, hasPublished)}</dd></div>` : ''}
          ${rules.approver || page.approverId ? `<div><dt>Approver</dt><dd>${pendingFieldCell(page.approverId, pendingOf('approverId'), actorLabel, hasPublished)}</dd></div>` : ''}
          ${/* The basis is shown wherever the date is. The editor makes an
                author state where a backdated effective date comes from, and
                then nobody downstream saw it: a compliance director wrote a
                paragraph of a send-back demanding an answer the record already
                held and was not showing him. Collecting evidence and hiding it
                is worse than not collecting it. */ ''}
          ${rules.effectiveDate ? `<div><dt>Effective date</dt><dd>${pendingFieldCell(page.effectiveDate, pendingOf('effectiveDate'), fmtDate, hasPublished)}${
            page.effectiveDateBasis
              ? `<div class="field-basis"><span class="muted">Stated basis:</span> ${esc(page.effectiveDateBasis)}
                   <span class="muted">— Canon records this and cannot verify it.</span></div>`
              : ''
          }</dd></div>` : ''}
          ${/* Past review is read from the DATE, not from the status: a page whose
                review date passed since the last sweep is already stale, and saying
                so here is what makes the warning true in the window before the
                sweep reaches it (USER-TESTING.md T1.4). */ ''}
          ${rules.reviewDate || page.reviewDate ? `<div><dt>Review date</dt><dd>${pendingFieldCell(page.reviewDate, pendingOf('reviewDate'), fmtDate, hasPublished)}${isPastReview(page.reviewDate) ? ' · <span class="past-review">past review</span>' : ''}</dd></div>` : ''}
          ${/* actorLabel, not the bare name: the `agent` and `system` tags were
                on Owner, on Approver and on every audit row — everywhere an
                auditor looks — and missing from the bylines a reader passes on
                the way to the text (round seven). Who wrote a version is
                exactly where the distinction matters. */ ''}
          <div><dt>Version</dt><dd>${current ? `v${page.currentVersion} · published ${fmtDateTime(current.createdAt)} by ${actorLabel(current.authorId)}` : 'Never published'}</dd></div>
          ${references.map(referencePlaceholderHTML).join('')}
        </dl>

        ${current ? `<article class="doc-body">${withWithheldLinks(page.withheldLinks, () => renderMarkdown(current.body))}</article>` : inReview ? `
          <div class="empty-state">
            <h2>Nothing published yet</h2>
            ${/* A page in review HAS text — it is in the panel above, which is
                  what approving publishes. Offering "Write the first draft"
                  here invited the approver to overwrite the very draft they
                  were reviewing, and it is the one action that is wrong for
                  everybody standing on this page right now. */ ''}
            ${/* A button, not an anchor to `#review-change`: the hash IS the
                  router, so a fragment link here navigates away from the page
                  it is trying to point at. See the delegated [data-scroll-to]
                  handler below. */ ''}
            <p>The text waiting for approval is under
              <button class="btn subtle" type="button" data-scroll-to="review-change">What is being approved</button>,
              above. It becomes v1 of this page when it is approved.</p>
          </div>` : `
          <div class="empty-state">
            <h2>Nothing published yet</h2>
            <p>This page has no published version. ${isArchived ? '' : 'Open the editor to write the first draft, then publish it.'}</p>
            ${isArchived ? '' : `<p><a class="btn primary" href="#/pages/${esc(id)}/edit">Write the first draft</a></p>`}
          </div>`}

        <div id="divergences-host"></div>
        <div id="relations-host"></div>
        <div id="related-host"></div>
        <div id="comments-host"></div>
      </section>
    </div>`;

  wireSidebar(collection, tree);
  wireAskAccess();
  renderAskAffordance('ask-affordance', page.collectionId);
  renderAttestationAffordance('attestation-affordance', { kind: 'page', id, title: page.title });

  app.querySelector('#act-submit')?.addEventListener('click', async () => {
    // Never a bare POST: the dialog restates who will be asked to sign and
    // lets the name be corrected at the click that commits to it (finding 9).
    try {
      await openSubmitReviewDialog(page, draft?.fields ?? null, route);
    } catch (err) { toastError(err); }
  });
  // The approver's typed note, held across the trip to the diff. "Show me the
  // changes" closes the dialog on purpose — the diff is the page behind it —
  // but closing used to discard whatever was in the note box, so reading the
  // changes cost a re-type (fourth round, Lena). Stashed here, in the view's
  // scope, and handed back when the dialog reopens; cleared only by the
  // approval that consumes it. Cancel keeps the stash too: cancelling is how
  // somebody leaves to look at something, not a request to be forgotten.
  let approveNoteDraft = '';
  app.querySelector('#act-approve')?.addEventListener('click', () => {
    const modal = openModal({
    title: 'Approve as Canonical',
    submitLabel: 'Approve',
    // The extent of the change is restated here, from the same summary the
    // panel behind this modal is drawn from, so the last thing read before the
    // button is what the button does.
    //
    // The note stays optional, and says why. Send back requires a comment
    // because a refusal without one is unperformable — the author is told "no"
    // and nothing else. An approval writes its own record: the version, the
    // approver's name, the instant, and the diff above. A required box here
    // would fill forty rows a quarter with "ok", which is not evidence of
    // consideration but a convincing imitation of it.
    body: `
      <p class="muted">Approving publishes the reviewed draft and grants the Canonical mark.
        ${change ? esc(changeSentence(change)) : ''}</p>
      ${/* And the extent in the other direction: what the Canonical mark will
            NOT be covering. Same count, same source, same words as the panel —
            the last thing read before the button should not be narrower than
            what the button does. */ ''}
      ${change && change.references.length ? `<p class="muted approve-fed">The
        ${change.references.length === 1 ? 'federated value' : `${change.references.length} federated values`} on this
        page ${change.references.length === 1 ? 'is' : 'are'} live and page-level:
        ${change.references.length === 1 ? 'it is' : 'they are'} resolved from
        ${change.references.length === 1 ? 'its source' : 'their sources'} on every read and can change afterwards
        without a version and without you. Your approval covers the text.</p>` : ''}
      ${change ? '<p><button type="button" class="btn subtle" id="approve-see-diff">Show me the changes</button></p>' : ''}
      <label>Note <input name="note" value="${esc(approveNoteDraft)}" placeholder="optional, kept in version history"></label>
      <p class="muted">Optional on purpose: what you approved is the version itself, with your name and the
        time on it. A note is worth reading when somebody chose to write one.</p>`,
    onSubmit: async (form) => {
      await api('POST', `/pages/${id}/approve`, form.note.value.trim() ? { note: form.note.value.trim() } : {});
      approveNoteDraft = ''; // consumed: it is in the version history now
      toast('Approved. This page is now Canonical.', 'ok');
      route();
    },
    });
    // Kept current as it is typed, so every way out of this dialog — the diff
    // button below, Cancel, the backdrop — leaves the note where reopening
    // finds it.
    modal.form.note.addEventListener('input', () => { approveNoteDraft = modal.form.note.value; });
    // The Approve button sits above the diff, so somebody can reach this modal
    // without having scrolled past what it is about. This closes the modal and
    // puts them in front of it — the one thing T4.2 says must not be optional.
    document.getElementById('approve-see-diff')?.addEventListener('click', () => {
      modal.close();
      document.getElementById('review-change')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
  app.querySelector('#act-sendback')?.addEventListener('click', () => openModal({
    title: 'Send back to the author',
    submitLabel: 'Send back',
    body: `
      <p class="muted">The page leaves review and unlocks for the author. Your comment goes to them.
        A page that entered review holding the Canonical mark keeps it: refusing the draft revokes nothing.</p>
      <label>Comment <textarea name="comment" rows="3" required placeholder="What needs to change before this can be Canonical?"></textarea></label>`,
    onSubmit: async (form) => {
      await api('POST', `/pages/${id}/send-back`, { comment: form.comment.value.trim() });
      toast('Sent back with your comment.', 'ok');
      route();
    },
  }));
  app.querySelector('#act-withdraw')?.addEventListener('click', () => openModal({
    title: 'Withdraw this submission',
    submitLabel: 'Withdraw',
    body: `
      <p class="muted">The page leaves review and the editor unlocks — a page that entered review holding
      the Canonical mark keeps it. Whoever was asked to review it is told it is no longer waiting on them,
      and the withdrawal is on the audit record.</p>
      <label>Reason <input name="reason" placeholder="optional, kept on the audit record"></label>`,
    onSubmit: async (form) => {
      const reason = form.reason.value.trim();
      await api('POST', `/pages/${id}/withdraw`, reason ? { reason } : {});
      toast('Withdrawn from review. It is a draft again.', 'ok');
      route();
    },
  }));
  app.querySelector('#act-archive')?.addEventListener('click', () => openModal({
    title: 'Archive this page',
    submitLabel: 'Archive',
    danger: true,
    body: '<p>Archived pages leave the tree and become read-only, but their history is preserved. Continue?</p>',
    onSubmit: async () => {
      await api('POST', `/pages/${id}/archive`);
      toast('Page archived.', 'ok');
      route();
    },
  }));

  // The send-back reason is a comment as well as a banner; this walks somebody
  // from one to the other. A plain `#comment-…` link cannot be used — the hash
  // is the router — so it scrolls, and marks the comment it landed on.
  app.querySelector('#goto-sentback-comment')?.addEventListener('click', () => {
    const target = document.getElementById(`comment-${page.sentBack?.commentId}`);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('comment-flash');
    setTimeout(() => target.classList.remove('comment-flash'), 2000);
  });

  renderReferences(id, references);
  // Where the record disagrees with itself (DATA-BACKBONE.md §7). Two separate
  // pieces of server, feature-detected separately: neither one's absence hides
  // the other, and a Canon that serves neither shows a page exactly as before.
  renderDivergencesPanel(id);
  renderRelationsPanel(id, page, relations);
  renderRelatedPanel(id);
  renderCommentsPanel(id, can?.comment ?? null, page.collectionId);
}

// ---------------------------------------------------------------------------
// Federated values (DATA-BACKBONE.md §6)
//
//   GET /pages/:id/references
//     -> [{ id, sourceId, sourceName, selector, key,
//           value, resolvedAt, fromCache, stale, error? }]
//
// Canon never copies a fact it does not own; it holds a reference and resolves
// it when the page is read. Three things this UI must therefore carry, because
// they are the difference between a federated value and a lie:
//
//   * staleness is displayed, not hidden — a value past its freshness window
//     is still the best known value, and saying so is calmer and more honest
//     than either hiding it or presenting it as current;
//   * a service-resolved value is marked, because an administrator choosing
//     that mode chose to publish the value to everyone who can see the
//     collection, and the reader deserves to know that on the page;
//   * a refused or failed reference is shown, never omitted — a missing value
//     must never be readable as "there is no such value".

function normalizeReference(r) {
  return {
    id: r?.id ?? r?.referenceId ?? null,
    sourceId: r?.sourceId ?? null,
    sourceName: r?.sourceName ?? r?.source?.name ?? null,
    selector: r?.selector ?? '',
    key: r?.key ?? '',
    label: r?.label ?? null,
    value: r?.value === undefined ? null : r.value,
    resolvedAt: r?.resolvedAt ?? null,
    fromCache: r?.fromCache === true,
    stale: r?.stale === true,
    error: r?.error ?? null,
    // The resolution payload need not restate the source's auth mode; where it
    // does not, it is looked up from the registered source (see resolveAuthMode).
    authMode: r?.authMode ?? null,
    serviceResolved: r?.serviceResolved === true,
    // DATA-BACKBONE.md §7: a resolved reference MAY carry a divergence marker,
    // meaning a corroborating source answered the same question differently.
    // The authoritative value above is untouched by it — "an unexplained
    // disagreement is not a reason to blank a field a system is entitled to
    // answer" — and the marker is read here so the field can say so.
    divergence: normalizeDivergence(r?.divergence, r?.id ?? r?.referenceId ?? null),
  };
}

// One normaliser for a divergence, whether it arrived inside a resolved
// reference or from GET /pages/:id/divergences. `true` is accepted as the
// minimum honest marker a server might send: it says a divergence exists and
// nothing more, and the UI then says exactly that much.
function normalizeDivergence(d, referenceId = null) {
  if (!d) return null;
  if (d === true) return { id: null, referenceId, state: 'open', bare: true };
  if (Array.isArray(d)) return normalizeDivergence(d[0], referenceId);
  if (typeof d !== 'object') return null;
  const state = d.state === 'closed' || d.closedAt ? 'closed' : 'open';
  return {
    id: d.id ?? d.divergenceId ?? null,
    referenceId: d.referenceId ?? referenceId,
    pageId: d.pageId ?? null,
    authoritySourceId: d.authoritySourceId ?? null,
    authoritySourceName: d.authoritySourceName ?? d.authoritySource?.name ?? null,
    authorityValue: d.authorityValue === undefined ? null : d.authorityValue,
    otherSourceId: d.otherSourceId ?? null,
    otherSourceName: d.otherSourceName ?? d.otherSource?.name ?? null,
    otherValue: d.otherValue === undefined ? null : d.otherValue,
    observedAt: d.observedAt ?? d.at ?? null,
    state,
    closedBy: d.closedBy ?? null,
    closedAt: d.closedAt ?? null,
    reason: d.reason ?? null,
    label: d.label ?? d.selector ?? null,
    bare: false,
  };
}

// What a source is called, from the divergence itself where it says, and from
// the registered source register where it does not. Never guessed: an unnamed
// source reads as "another source", which is true.
function divergenceSourceName(id, name, sourcesById) {
  return name || sourcesById?.get(id)?.name || (id ? clip(id, 24) : null);
}

// Whether this value was resolved with a service identity — from the row if it
// says so, otherwise from the registered source it names. Anything unknown is
// left unmarked rather than guessed at in either direction.
function resolveAuthMode(r, sourcesById) {
  if (r.serviceResolved) return 'service';
  if (r.authMode) return r.authMode;
  return sourcesById?.get(r.sourceId)?.authMode ?? null;
}

// GET /sources, cached for the session and never fatal: it is only ever used
// to enrich, so a server without it simply leaves values unenriched.
async function loadSourcesById() {
  if (state.sourcesById) return state.sourcesById;
  if (state.features.sources === false) return null;
  try {
    const list = await api('GET', '/sources');
    state.features.sources = true;
    state.sourcesById = new Map((Array.isArray(list) ? list : []).map((s) => [s.id, s]));
    return state.sourcesById;
  } catch (err) {
    if (err.status === 404 || err.status === 405) state.features.sources = false;
    return null;
  }
}

function referenceLabel(ref) {
  return clip(ref.label || humanizeKey(ref.selector || ref.key || 'Value'), 48);
}

// A federated value is untrusted text from another system, and it may be a
// string, a number or a boolean: everything is stringified and escaped, and
// `false` and `0` are values, not absences.
function referenceValueText(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

function referenceErrorText(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  return err.message ?? err.error ?? err.code ?? 'no reason given';
}

// The provenance line is height-reserved, so a source's error string cannot be
// allowed to run away with it. The whole text stays in the field's tooltip.
function clip(s, max = 90) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// A source's error string may or may not be punctuated; the sentence Canon
// builds around it should read either way.
function endSentence(s) {
  const t = String(s ?? '').trim();
  return !t || /[.!?…]$/.test(t) ? t : `${t}.`;
}

// Every state of a reference — resolving, fresh, stale, refused — is rendered
// through this one shape, so the row is the same size before and after the
// value lands and nothing below the field block ever moves.
function referenceRowHTML({ r, cls, valueHTML, marks, prov, valueTitle }) {
  const title = [
    valueTitle ? `Value: ${valueTitle}` : '',
    r.selector ? `selector: ${r.selector}` : '',
    r.key ? `key: ${r.key}` : '',
  ].filter(Boolean).join('\n');
  return `
    <div class="ref-field ${cls}" data-ref-slot="${esc(slotKey(r))}"${title ? ` title="${esc(title)}"` : ''}>
      <dt><span class="ref-label">${esc(referenceLabel(r))}</span>
        <span class="ref-mark-dt">federated</span></dt>
      <dd>
        <div class="ref-value-row">${valueHTML}${marks.join('')}</div>
        <p class="ref-prov">${prov}</p>
      </dd>
    </div>`;
}

function askerMarkHTML() {
  return `<span class="kind-tag ref-asker"
    title="Resolved with your own identity, so another reader of this page may see a different value here, or none">resolved for you</span>`;
}

function serviceMarkHTML() {
  return `<span class="kind-tag ref-service"
    title="Resolved with a service identity, so this value is visible to everyone who can view this collection">service-resolved</span>`;
}

const SERVICE_SENTENCE = 'Service-resolved: visible to everyone who can view this collection.';

// First paint. The page payload names the label, the source and the auth mode
// before anything is resolved, so the only thing still unknown is the value
// itself — and it is the only thing drawn as a placeholder.
function referencePlaceholderHTML(ref) {
  const r = normalizeReference(ref);
  const service = r.authMode === 'service' || r.serviceResolved;
  const perAsker = !service && r.authMode === 'per_asker';
  return referenceRowHTML({
    r,
    cls: 'is-resolving',
    valueHTML: '<span class="skel-line ref-skel-value" aria-hidden="true"></span>'
      + '<span class="sr-only">Resolving this value from its source…</span>',
    marks: service ? [serviceMarkHTML()] : perAsker ? [askerMarkHTML()] : [],
    prov: `${esc(clip(r.sourceName || r.sourceId || 'Its source', 32))} · resolving…`
      + (service ? ` ${SERVICE_SENTENCE}` : ''),
  });
}

function referenceFieldHTML(r, sourcesById) {
  const source = clip(r.sourceName || r.sourceId || 'An unnamed source', 32);
  const value = referenceValueText(r.value);
  // A field value is a value, not a document: an overlong one is shown clipped
  // with the whole of it in the field's tooltip, so one runaway string cannot
  // resize the row that was reserved for it.
  const shown = value === null ? null : clip(value, 64);
  const age = fmtAgo(r.resolvedAt) ?? 'at an unrecorded time';
  const at = r.resolvedAt ? ` (${fmtDateTime(r.resolvedAt)})` : '';
  const service = resolveAuthMode(r, sourcesById) === 'service';
  const marks = [];
  let cls = '';
  let valueHTML;
  let prov;

  if (r.error) {
    // Refused or unanswered. The reference is shown either way: the reader has
    // to be able to tell "the source would not say" from "there is nothing".
    cls = 'is-error';
    const why = `${esc(source)} did not answer: ${esc(endSentence(clip(referenceErrorText(r.error), 70)))}`;
    if (value !== null) {
      valueHTML = `<span class="ref-value">${esc(shown)}</span>`;
      marks.push('<span class="badge badge-last-known sm">last known good</span>');
      prov = `${why} Showing the value last resolved ${esc(age)}${at}; it may have changed since.`;
    } else {
      valueHTML = '<span class="ref-value is-unresolved">Not resolved</span>';
      marks.push('<span class="badge badge-unresolved sm">unresolved</span>');
      prov = `${why} Not an empty value — Canon has no cached answer and will not invent one.`;
    }
  } else if (value === null) {
    valueHTML = '<span class="ref-value is-unresolved">No value returned</span>';
    marks.push('<span class="badge badge-unresolved sm">no value</span>');
    prov = `${esc(source)} answered ${esc(age)}${at} without a value for this key.`;
  } else if (r.stale) {
    cls = 'is-stale';
    valueHTML = `<span class="ref-value">${esc(shown)}</span>`;
    marks.push('<span class="badge badge-stale sm">stale</span>');
    prov = `${esc(source)} · last confirmed ${esc(age)}${at}, past its freshness window.
      Still the best known value, not confirmed recently.`;
  } else {
    valueHTML = `<span class="ref-value">${esc(shown)}</span>`;
    prov = `${esc(source)} · resolved ${esc(age)}${at}${r.fromCache ? ' · from cache, within its freshness window' : ''}.`;
  }

  if (service) {
    marks.push(serviceMarkHTML());
  } else if (authModeOf(r, sourcesById) === 'per_asker') {
    marks.push(askerMarkHTML());
    prov += ` ${SERVICE_SENTENCE}`;
  }

  // A divergence (DATA-BACKBONE.md §7) changes NOTHING about the value above.
  // The authoritative source is entitled to answer and its answer keeps
  // displaying; what is added is the fact that somebody else answered
  // differently, what they said, and when it was seen. Calm, not alarming: a
  // disagreement between two systems is a fact about the systems, never a vote
  // about the value.
  const divergence = r.divergence;
  if (divergence && divergence.state === 'open') {
    cls += ' has-divergence';
    marks.push(`<span class="badge badge-divergence sm" role="button" tabindex="0"
      data-divergence-mark="${esc(divergence.id ?? '')}"
      title="Another source answered this differently. The value shown is still the authoritative one.">another source disagrees</span>`);
    const other = divergenceSourceName(divergence.otherSourceId, divergence.otherSourceName, sourcesById);
    const said = referenceValueText(divergence.otherValue);
    const seen = fmtAgo(divergence.observedAt);
    prov += divergence.bare || (!other && said === null)
      ? ' Another source disagrees with this value; the disagreement is open below.'
      : ` ${esc(other ?? 'Another source')} answered ${said === null ? 'differently' : `“${esc(clip(said, 40))}”`}` +
        `${seen ? `, seen ${esc(seen)}` : ''}. The value above is still the authoritative one.`;
  }

  return referenceRowHTML({ r, cls, valueHTML, marks, prov, valueTitle: value !== shown ? value : null });
}

// The endpoint itself failing is different from a single reference failing:
// the declared references stay on the page, stated as unresolved, because
// dropping them would read as "this page has no such value".
function referenceUnreachableHTML(ref, err) {
  const r = normalizeReference(ref);
  const service = r.authMode === 'service' || r.serviceResolved;
  const perAsker = !service && r.authMode === 'per_asker';
  return referenceRowHTML({
    r,
    cls: 'is-error',
    valueHTML: '<span class="ref-value is-unresolved">Not resolved</span>',
    marks: [
      '<span class="badge badge-unresolved sm">unresolved</span>',
      ...(service ? [serviceMarkHTML()] : perAsker ? [askerMarkHTML()] : []),
    ],
    prov: `Canon could not reach its own resolver: ${esc(endSentence(clip(err?.message ?? 'the request failed')))}
      The reference is still on this page; only its value is missing.`,
  });
}

async function renderReferences(pageId, declared) {
  const block = app.querySelector('.field-block');
  if (!block || state.features.references === false) {
    if (block) block.querySelectorAll('[data-ref-slot]').forEach((el) => el.remove());
    return;
  }
  let rows;
  let sourcesById = null;
  try {
    // Both at once, and rendered in one pass: the placeholders hold the space
    // until every value is ready, so nothing on the page moves twice.
    const [r, byId] = await Promise.all([
      api('GET', `/pages/${pageId}/references`),
      loadSourcesById(),
    ]);
    state.features.references = true;
    sourcesById = byId;
    rows = (Array.isArray(r) ? r : (r?.references ?? [])).map(normalizeReference);
  } catch (err) {
    if (err.status === 404 || err.status === 405) {
      // Not built yet: the reference block is not there at all.
      state.features.references = false;
      if (block.isConnected) block.querySelectorAll('[data-ref-slot]').forEach((el) => el.remove());
      return;
    }
    if (!block.isConnected) return;
    for (const ref of declared) {
      const slot = block.querySelector(`[data-ref-slot="${cssEscape(slotKey(ref))}"]`);
      if (slot) slot.outerHTML = referenceUnreachableHTML(ref, err);
    }
    return;
  }
  if (!block.isConnected) return; // the view moved on while we were resolving

  const seen = new Set();
  for (const row of rows) {
    const slot = block.querySelector(`[data-ref-slot="${cssEscape(slotKey(row))}"]`);
    if (slot) { slot.outerHTML = referenceFieldHTML(row, sourcesById); seen.add(slotKey(row)); }
    else block.insertAdjacentHTML('beforeend', referenceFieldHTML(row, sourcesById)); // not declared in the page payload
  }
  // A declared reference the resolver said nothing about is still a reference.
  for (const ref of declared) {
    if (seen.has(slotKey(ref))) continue;
    const slot = block.querySelector(`[data-ref-slot="${cssEscape(slotKey(ref))}"]`);
    if (slot && slot.classList.contains('is-resolving')) {
      slot.outerHTML = referenceUnreachableHTML(ref, { message: 'the resolver returned no answer for this reference' });
    }
  }

  // The divergence mark beside a value takes the reader to the whole record of
  // it — what each source said and when — rather than trying to fit that into
  // a badge.
  const jump = (id) => {
    const target = id
      ? document.querySelector(`[data-divergence="${cssEscape(id)}"]`)
      : document.getElementById('divergences-panel');
    const fallback = document.getElementById('divergences-panel');
    const el = target ?? fallback;
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1400);
  };
  block.querySelectorAll('[data-divergence-mark]').forEach((mark) => {
    mark.addEventListener('click', () => jump(mark.dataset.divergenceMark));
    mark.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jump(mark.dataset.divergenceMark); }
    });
  });
}

// ---------------------------------------------------------------------------
// Divergences — where a corroborating source disagrees with its authority
// (DATA-BACKBONE.md §7)
//
//   GET  /pages/:id/divergences
//     -> [{ id, referenceId, pageId, authoritySourceId, authorityValue,
//           otherSourceId, otherValue, observedAt,
//           state: 'open' | 'closed', closedBy?, closedAt?, reason? }]
//   POST /divergences/:id/close   { reason }   — the reason is required
//
// Feature-detected on its own, exactly as /ask, /sources and the map are: where
// the endpoint 404s there is no panel, no marker beside a value, and nothing on
// the page that says a feature is missing.
//
// Three things this UI must carry, because they are §7 itself:
//
//   * the authoritative value keeps displaying, normally. "An unexplained
//     disagreement is not a reason to blank a field a system is entitled to
//     answer." The marker sits beside the value; it never replaces it.
//   * both answers are shown, attributed and dated, and NEITHER is presented as
//     the right one. Canon surfaces contradiction and does not resolve it: no
//     averaging, no fresher-wins, no confidence score.
//   * closing takes a reason, and closing is a DECISION THE RECORD KEEPS. It is
//     not a dismissal, and a divergence never clears itself because two systems
//     drifted back into agreement.

function divergenceValueHTML(value) {
  const text = referenceValueText(value);
  if (text === null) return '<span class="dv-value is-empty">no value</span>';
  return `<span class="dv-value" title="${esc(text)}">${esc(clip(text, 60))}</span>`;
}

function divergenceEntryHTML(d, sourcesById) {
  const authority = divergenceSourceName(d.authoritySourceId, d.authoritySourceName, sourcesById) ?? 'The authority';
  const other = divergenceSourceName(d.otherSourceId, d.otherSourceName, sourcesById) ?? 'Another source';
  const seen = fmtAgo(d.observedAt);
  const at = d.observedAt ? fmtDateTime(d.observedAt) : null;
  const label = d.label ? clip(d.label, 48) : null;
  const closed = d.state === 'closed';
  return `
    <li class="divergence ${closed ? 'is-closed' : 'is-open'}"${d.id ? ` data-divergence="${esc(d.id)}"` : ''}>
      <div class="dv-head">
        <span class="badge ${closed ? 'badge-divergence-closed' : 'badge-divergence'} sm">${closed ? 'settled' : 'open'}</span>
        ${label ? `<span class="dv-label">${esc(label)}</span>` : ''}
        ${at ? `<span class="muted dv-seen" title="${esc(at)}">seen ${esc(seen ?? at)}</span>` : ''}
      </div>
      ${d.bare ? `
        <p class="dv-bare muted">Another source answered this differently. This Canon did not say which, or what it
          said — only that the disagreement exists.</p>` : `
        <div class="dv-pair">
          <div class="dv-side dv-authority">
            <span class="dv-role">Authoritative — ${esc(authority)}</span>
            ${divergenceValueHTML(d.authorityValue)}
            <span class="dv-note muted">The system this field names as owning the fact. Its value is what the page shows.</span>
          </div>
          <div class="dv-side dv-other">
            <span class="dv-role">Corroborating — ${esc(other)}</span>
            ${divergenceValueHTML(d.otherValue)}
            <span class="dv-note muted">A second system answering the same question. Its disagreement is a signal about
              the systems, never a vote about the value.</span>
          </div>
        </div>`}
      ${closed ? `
        <p class="dv-settled">Closed by ${actorLabel(d.closedBy)}${d.closedAt ? ` · ${esc(fmtDateTime(d.closedAt))}` : ''}${
          d.reason ? `<span class="dv-reason">${esc(d.reason)}</span>` : ''
        }</p>` : `
        <div class="dv-actions">
          ${d.id ? `<button class="btn subtle" type="button" data-close-divergence="${esc(d.id)}">Close this divergence…</button>` : ''}
          <span class="muted dv-hint">Closing records a decision. It does not remove the disagreement from the record.</span>
        </div>`}
    </li>`;
}

async function renderDivergencesPanel(pageId) {
  const host = document.getElementById('divergences-host');
  if (!host || state.features.divergences === false) return;
  let rows;
  let sourcesById = null;
  try {
    const [r, byId] = await Promise.all([
      api('GET', `/pages/${pageId}/divergences`),
      loadSourcesById(),
    ]);
    state.features.divergences = true;
    sourcesById = byId;
    rows = (Array.isArray(r) ? r : (r?.divergences ?? []))
      .map((d) => normalizeDivergence(d))
      .filter(Boolean);
  } catch (err) {
    // Not built yet: there is no panel, and nothing on the page mentions one.
    if (err.status === 404 || err.status === 405) { state.features.divergences = false; return; }
    if (!host.isConnected) return;
    host.innerHTML = `<section class="panel"><h2 class="h-small">Where a source disagrees</h2>
      <p class="muted">Canon could not read this page's divergences: ${esc(err.message)}.
        That is this request failing, not the record saying there are none.</p></section>`;
    return;
  }
  if (!host.isConnected) return;
  // Nothing to say is said by saying nothing: a page with no divergence carries
  // no panel about divergences.
  if (!rows.length) { host.innerHTML = ''; return; }

  const open = rows.filter((d) => d.state === 'open');
  const closed = rows.filter((d) => d.state === 'closed');
  host.innerHTML = `
    <section class="panel divergences ${open.length ? 'has-open' : ''}" id="divergences-panel">
      <h2 class="h-small">Where a source disagrees</h2>
      <p class="dv-lede">Two systems answered the same question differently. Canon shows both and decides between them
        at no point — no averaging, no preferring the fresher answer, no score that quietly ranks one system above
        another. The value on this page is still the one its authority gave.</p>
      ${open.length ? `<ul class="dv-list">${open.map((d) => divergenceEntryHTML(d, sourcesById)).join('')}</ul>` : ''}
      ${closed.length ? `
        <h3 class="dv-subhead">Settled${open.length ? '' : ' — nothing here is open'}</h3>
        <p class="muted dv-subnote">A closed divergence stays on the record with the reason it was closed. It is a
          decision somebody took, not a flag that cleared.</p>
        <ul class="dv-list">${closed.map((d) => divergenceEntryHTML(d, sourcesById)).join('')}</ul>` : ''}
    </section>`;

  host.querySelectorAll('[data-close-divergence]').forEach((btn) => {
    btn.addEventListener('click', () => openModal({
      title: 'Close this divergence',
      submitLabel: 'Close it, with this reason',
      body: `
        <p class="muted">Closing is a decision the record keeps, not a dismissal. Your reason stays on this page,
          attributed to you, and the divergence does not reopen or clear itself because the two systems happen to
          agree again.</p>
        <label>Why is this settled?
          <textarea name="reason" rows="3" required
            placeholder="The copy was wrong and has been corrected upstream · the definitions differ, and here is how · this source should not be corroborating this field"></textarea></label>`,
      onSubmit: async (form) => {
        const reason = form.reason.value.trim();
        if (!reason) throw { message: 'Closing a divergence takes a reason: it is a decision the record keeps.' };
        try {
          await api('POST', `/divergences/${btn.dataset.closeDivergence}/close`, { reason });
        } catch (err) {
          if (err.status === 404 || err.status === 405) {
            state.features.divergences = false;
            host.innerHTML = '';
            throw { message: 'Closing a divergence is not available on this Canon yet.' };
          }
          throw err;
        }
        toast('Closed. The reason is on the record.', 'ok');
        renderDivergencesPanel(pageId);
      },
    }));
  });
}

// ---------------------------------------------------------------------------
// Page relations — conflicts with, supersedes (DATA-BACKBONE.md §7)
//
//   GET    /pages/:id/relations
//     -> [{ id, fromPageId, toPageId, kind, note, assertedBy, assertedAt,
//           pageId, end, reads, other: { id, title, type, status, collectionId } }]
//   POST   /pages/:id/relations   { toPageId, kind, note? }
//   DELETE /relations/:id
//
// `reads` is the relation as seen FROM this page, which is the only voice a
// page view can honestly speak in: the same stored row is "supersedes" at one
// end and "superseded by" at the other.
//
// Nothing here resolves anything. Asserting that two pages conflict changes
// neither page's status, neither page's text, and neither page's standing —
// Canon surfaces contradiction and routes it to the person accountable for the
// page, and that is the whole of it.

const RELATION_READ_LABELS = {
  conflicts_with: 'Conflicts with',
  supersedes: 'Supersedes',
  superseded_by: 'Superseded by',
};
const RELATION_READ_HELP = {
  conflicts_with: 'A person asserted that these two pages contradict each other. Both are still the record; neither has been demoted.',
  supersedes: 'A person asserted that this page replaces that one. The replaced page keeps its standing and its history.',
  superseded_by: 'A person asserted that another page replaces this one. This page keeps its standing and its history; saying so archives nothing.',
};

function normalizeRelation(r) {
  const kind = r?.kind === 'supersedes' ? 'supersedes' : 'conflicts_with';
  const other = r?.other ?? {};
  const reads = RELATION_READ_LABELS[r?.reads] ? r.reads : kind === 'conflicts_with' ? 'conflicts_with' : 'supersedes';
  // The far page is withheld when the reader holds no role in its collection.
  // The relation is still listed — existence, never identity — so everything
  // below has a shape for "there is one, and it is not describable here".
  const withheld = other.withheld === true;
  return {
    id: r?.id ?? null,
    kind,
    reads,
    note: r?.note ?? null,
    assertedBy: r?.assertedBy ?? null,
    assertedAt: r?.assertedAt ?? null,
    withheld,
    other: withheld
      ? { id: null, title: null, status: null, type: null }
      : {
          id: other.id ?? r?.otherPageId ?? null,
          title: other.title ?? '(untitled page)',
          status: other.status ?? null,
          type: other.type ?? null,
        },
  };
}

// How the far end reads when it is withheld. One phrase, used by the panel, the
// standing banner and the owner's queue, so the three cannot drift into three
// different descriptions of the same absence. Not "(hidden page)" and not a
// redacted title: there is no page here to name, and saying "a page" with a
// styled blank invites the reader to guess at one.
const WITHHELD_TARGET = 'a page you do not have access to';

// Statuses a grounded answer may draw on — retrieval.ts ANSWERABLE_STATUSES.
// Canonical, and Canonical whose review date has passed.
const ANSWERABLE_STATUSES = ['canonical', 'needs_update'];

// "Superseded by X" reads as "the answer moved over there". It only means that
// once X is part of the official record. Where the replacement is still a
// draft or in review, Ask will not use it and this page is still what the
// record serves — so the subject has NO approved answer, and a banner that
// stops at naming the replacement makes it look filled.
function supersededByUnanswerableHTML(rel) {
  if (rel.reads !== 'superseded_by') return '';
  // A withheld replacement has no status to read, and the honest thing is to
  // say the standing is unknown rather than pick a side. Claiming it IS in the
  // record would imply an approved answer nobody here can check; claiming it is
  // NOT would be a guess about a page this reader was never shown.
  if (rel.withheld) {
    return `<p class="rel-note muted">Whether that replacement is part of the official record is not
      something this page can tell you. Until you know, this page is what the record serves.</p>`;
  }
  const status = rel.other.status;
  if (!status || ANSWERABLE_STATUSES.includes(status)) return '';
  return `<p class="rel-note muted">The page named as its replacement is not part of the official record yet,
    so nothing here has been approved on this subject. This page is still what the record serves.</p>`;
}

function relationEntryHTML(rel) {
  return `
    <li class="relation rel-${esc(rel.reads)}${rel.withheld ? ' rel-withheld' : ''}"${rel.id ? ` data-relation="${esc(rel.id)}"` : ''}>
      <div class="rel-head">
        <span class="rel-kind" title="${esc(RELATION_READ_HELP[rel.reads])}">${esc(RELATION_READ_LABELS[rel.reads])}</span>
        ${rel.withheld
          ? `<span class="rel-target rel-target-withheld">${esc(WITHHELD_TARGET)}</span>`
          : rel.other.id
            ? `<a class="rel-target" href="#/pages/${esc(rel.other.id)}">${esc(rel.other.title)}</a>`
            : `<span class="rel-target">${esc(rel.other.title)}</span>`}
        ${!rel.withheld && rel.other.status ? badge(rel.other.status, 'sm') : ''}
      </div>
      ${rel.withheld
        // No note, and it is not that none was written: the reason for a
        // conflict describes the other page, which is the thing being withheld.
        // Saying "no note was recorded" here would be false.
        //
        // "Or the collection's administrators" used to be the end of the
        // sentence and nothing more: a reader who could not name the collection
        // had no way to reach anybody in it. The control carries the RELATION,
        // which is the only thing this reader legitimately holds — the server
        // resolves which collection that is and never says (access.ts).
        ? `<p class="rel-note muted">The reason recorded with this assertion describes that page, so it is
            not shown here. Ask ${esc(actorName(rel.assertedBy))}, or ask the administrators of whichever
            collection holds it.${rel.id
              ? ` <button type="button" class="btn subtle ask-access" data-ask-access data-ground="relation"
                  data-relation="${esc(rel.id)}">Ask for access</button>`
              : ''}</p>`
        : rel.note ? `<p class="rel-note">${esc(rel.note)}</p>` : `
        <p class="rel-note muted">No note was recorded with this assertion.</p>`}
      ${supersededByUnanswerableHTML(rel)}
      <p class="rel-meta muted">Asserted by ${actorLabel(rel.assertedBy)}${
        rel.assertedAt ? ` · ${esc(fmtAgo(rel.assertedAt) ?? '')} (${esc(fmtDateTime(rel.assertedAt))})` : ''
      }${rel.id ? ` · <button class="btn subtle rel-withdraw" type="button" data-withdraw="${esc(rel.id)}">Withdraw</button>` : ''}</p>
    </li>`;
}

/**
 * The relations for one page, normalised, or null where this Canon does not
 * serve them or the read failed.
 *
 * Null is not "there are none": the standing banner and the panel both draw
 * nothing on a null, because a read that failed must never be rendered as the
 * record saying a page is uncontested.
 */
async function loadRelations(pageId) {
  if (state.features.relations === false) return null;
  try {
    const r = await api('GET', `/pages/${pageId}/relations`);
    state.features.relations = true;
    return (Array.isArray(r) ? r : (r?.relations ?? [])).map(normalizeRelation);
  } catch (err) {
    if (err.status === 404 || err.status === 405) state.features.relations = false;
    return null;
  }
}

async function renderRelationsPanel(pageId, page, preloaded = undefined) {
  const host = document.getElementById('relations-host');
  if (!host || state.features.relations === false) return;
  // The page view already holds these — it needs them above the fold — so the
  // panel is drawn from the same rows rather than asking again and risking a
  // panel that disagrees with the banner over it.
  const rows = preloaded === undefined ? await loadRelations(pageId) : preloaded;
  if (!rows) return;
  if (!host.isConnected) return;

  const archived = page?.status === 'archived';
  // Whether this actor may assert one AT THIS END. Asserting needs `edit` on
  // both pages' collections; this is the half the page can answer, and the
  // other half is answered inside the dialog, per page picked (see
  // `openRelationModal`). Absent on an older server, and then offered as before.
  const group = refusalGroup('these controls');
  const assertHTML = archived
    ? ''
    : group.offer(
        page?.abilities?.assertRelation ?? null,
        'Assert a relation…',
        '<button class="btn subtle" type="button" id="rel-assert">Assert a relation…</button>',
        { className: 'btn subtle' },
      );
  host.innerHTML = `
    <section class="panel relations ${rows.some((r) => r.reads === 'conflicts_with') ? 'has-conflict' : ''}" id="relations-panel">
      <div class="rel-panel-head">
        <h2 class="h-small">Conflicts and supersessions</h2>
        ${assertHTML}
      </div>
      <p class="rel-lede">Explicit relations between pages, written down by a person. Canon draws a contradiction
        rather than deciding it: nothing here changes what either page says, the standing it holds, or whether it can
        be cited.</p>
      ${group.noteHTML()}
      ${rows.length
        ? `<ul class="rel-list">${rows.map(relationEntryHTML).join('')}</ul>`
        // A complete statement again: the panel now lists relations whose far
        // page is withheld, so an empty panel really does mean the record holds
        // none. It said "is shown for this page" while relations to invisible
        // pages were silently dropped, which was the most it could honestly
        // claim then.
        : `<p class="muted rel-empty">No conflict or supersession has been asserted for this page.</p>`}
    </section>`;

  host.querySelector('#rel-assert')?.addEventListener('click', () => openRelationModal(pageId, page));
  wireAskAccess(host);
  host.querySelectorAll('[data-withdraw]').forEach((btn) => {
    btn.addEventListener('click', () => openModal({
      title: 'Withdraw this relation',
      submitLabel: 'Withdraw',
      danger: true,
      body: `<p>The record will no longer hold that these two pages are related, and the map will stop drawing it.
        Both pages are otherwise untouched. The assertion and this withdrawal both stay in the audit log.</p>`,
      onSubmit: async () => {
        await api('DELETE', `/relations/${btn.dataset.withdraw}`);
        toast('Withdrawn.', 'ok');
        // The whole view, not just this panel: withdrawing a conflict changes
        // the page's standing, and the banner that states it is at the top.
        // Redrawing the register under a banner that still says "contested"
        // would leave the two halves of one fact disagreeing on screen.
        route();
      },
    }));
  });
}

// Asserting one. The other page is chosen through the search the record
// already has; where search is not served, its id is typed in, because a
// relation names a page and a page has an id.
//
// AND WHICH COLLECTION SAID NO.
//
// Asserting a relation needs `edit` on BOTH pages' collections, because a
// relation is a statement about two pages and somebody who may edit only one of
// them would be writing a claim onto a page they have no standing over. A
// contributor holding `edit` here picked a page in another collection, wrote
// the note, pressed the solid green **Assert it** — and nothing happened. The
// dialog stayed open, the panel still said the record held no conflict, and the
// only explanation was a toast behind this dialog's own backdrop that had
// already gone: "Requires edit access to this collection." *Which* collection?
// "The one I'm on, where I hold edit? Or the one I'm pointing at? It doesn't
// say, and it names nobody to ask."
//
// This matters more than the other two refusals in the same round, because the
// one real contradiction in the seeded record is cross-collection, and
// cross-boundary is where contradictions come from.
//
// So the far end is answered the way the near end is: from the server. Every
// collection this actor can see carries `abilities.assertRelation` —
// `collectionAbilities`, a mirror of relations.ts and never a gate — and its
// sentence names that collection, what they hold there, and who does hold it.
// The picker marks a page it would be refused against rather than letting
// somebody write a note first, the way the approver picker lists only real
// approvers. The server still decides; nothing here is the check.
function openRelationModal(pageId, page) {
  const searchable = state.features.search === true;
  // Collection id -> what the server says about asserting a relation there.
  // Fetched once, beside the dialog rather than before it, so opening it is
  // never held up by a request; the picker reads whatever has arrived and the
  // server is the backstop either way.
  let byCollection = new Map();
  api('GET', '/collections')
    .then((list) => {
      byCollection = new Map(
        (Array.isArray(list) ? list : []).map((c) => [c.id, { name: c.name, assert: c.abilities?.assertRelation ?? null }]),
      );
    })
    .catch(() => { /* an older server answers for both ends at the last click */ });

  // Why this actor could not assert against that page, in the server's words —
  // or null where nothing says they cannot.
  const whyNot = (item) => {
    if (item.status === 'archived') {
      return 'That page is archived and read-only, so no relation may be asserted against it.';
    }
    const c = byCollection.get(item.collectionId);
    if (!c || !c.assert || c.assert.can !== false) return null;
    return c.assert.why;
  };

  openModal({
    title: 'Assert a relation between two pages',
    submitLabel: 'Assert it',
    body: `
      <p class="muted">Canon records that two pages disagree, or that one replaced the other. It does not resolve
        either: both pages keep their text and their standing, and settling it stays a person's job.</p>
      <label>This page&hellip;
        <select name="reads">
          <option value="conflicts_with">conflicts with</option>
          <option value="supersedes">supersedes</option>
          <option value="superseded_by">is superseded by</option>
        </select>
      </label>
      ${searchable ? `
        <label>&hellip;this one
          <input name="q" type="search" autocomplete="off" placeholder="Search the record by title&hellip;">
        </label>
        <div class="rel-picks" id="rel-picks" hidden></div>
        ${/* OUTSIDE the scrolling list. It lived inside it for one draft, where
              it was a sentence you had to scroll a 12rem box to find — which is
              the same defect as a toast in the corner, wearing a different
              coat. */ ''}
        <div id="rel-pick-note"></div>
        <p class="rel-chosen muted" id="rel-chosen">No page chosen yet.</p>
        <input type="hidden" name="toPageId">`
        : `<label>&hellip;this one, by page id
          <input name="toPageId" required placeholder="the other page's id">
        </label>`}
      <label>Note
        <textarea name="note" rows="3"
          placeholder="How do they disagree? Which sentence in each, and what does each one say?"></textarea></label>
      <p class="muted rel-note-hint" id="rel-note-hint">Required for a conflict: an unexplained assertion that two
        pages contradict each other is not something the next person can settle.</p>`,
    onSubmit: async (form) => {
      const reads = form.reads.value;
      const toPageId = form.toPageId.value.trim();
      const note = form.note.value.trim();
      if (!toPageId) throw { message: 'Choose the other page first: a relation names two pages.' };
      if (toPageId === pageId) throw { message: 'A page cannot conflict with or supersede itself.' };
      if (reads === 'conflicts_with' && !note) {
        throw { message: 'A conflict takes a note saying how the two pages disagree.' };
      }
      // "Superseded by" is the same stored relation asserted from the other
      // end, so that is exactly how it is sent: the other page supersedes this
      // one. Both ends need `edit` either way, which the server enforces.
      const body = reads === 'superseded_by'
        ? { path: `/pages/${toPageId}/relations`, payload: { toPageId: pageId, kind: 'supersedes', note: note || null } }
        : { path: `/pages/${pageId}/relations`, payload: { toPageId, kind: reads, note: note || null } };
      await api('POST', body.path, body.payload);
      toast('Asserted. It is on the page and on the map.', 'ok');
      // The view, not the panel: a conflict asserted here is this page's
      // standing from now on, and standing is stated at the top.
      route();
    },
  });

  const root = document.getElementById('modal-root');
  const form = root.querySelector('form');
  const hint = root.querySelector('#rel-note-hint');
  const reads = form.querySelector('[name=reads]');
  reads.addEventListener('change', () => {
    hint.hidden = reads.value !== 'conflicts_with';
  });
  if (!searchable) return;

  const q = form.querySelector('[name=q]');
  const picks = root.querySelector('#rel-picks');
  const note = root.querySelector('#rel-pick-note');
  const chosen = root.querySelector('#rel-chosen');
  const hidden = form.querySelector('[name=toPageId]');
  let timer = null;
  q.addEventListener('input', () => {
    clearTimeout(timer);
    const term = q.value.trim();
    if (term.length < 2) { picks.hidden = true; return; }
    timer = setTimeout(async () => {
      let items = [];
      try {
        const r = await api('GET', `/search?q=${encodeURIComponent(term)}`);
        items = (Array.isArray(r) ? r : (r?.results ?? r?.pages ?? r?.hits ?? []))
          .filter((it) => (it.pageId ?? it.id) !== pageId)
          .slice(0, 8);
      } catch { picks.hidden = true; return; }
      // A page this actor could not assert against is still LISTED — it is in
      // the record and hiding it would be its own kind of lie — but it is
      // marked, unselectable, and carries the sentence that says which
      // collection refused and who holds the role there.
      const group = refusalGroup('these pages');
      const rows = items.map((it) => {
        const id = it.pageId ?? it.id;
        const title = it.title ?? '(untitled)';
        const where = byCollection.get(it.collectionId)?.name ?? null;
        const label = `${esc(title)} ${it.status ? badge(it.status, 'sm') : ''}
          ${where ? `<span class="muted rel-pick-where">${esc(where)}</span>` : ''}`;
        return group.offer(
          whyNot(it) ? { can: false, why: whyNot(it) } : null,
          label,
          `<button type="button" class="rel-pick" data-id="${esc(id)}"
            data-title="${esc(title)}" data-where="${esc(where ?? '')}">${label}</button>`,
          { className: 'rel-pick' },
        );
      });
      picks.innerHTML = items.length
        ? rows.join('')
        : '<p class="muted rel-pick-empty">Nothing you can see matches.</p>';
      picks.hidden = false;
      note.innerHTML = items.length ? group.noteHTML() : '';
      picks.querySelectorAll('.rel-pick:not(.is-refused)').forEach((btn) => {
        btn.addEventListener('click', () => {
          hidden.value = btn.dataset.id;
          chosen.textContent = btn.dataset.where
            ? `Chosen: ${btn.dataset.title} — in ${btn.dataset.where}`
            : `Chosen: ${btn.dataset.title}`;
          chosen.classList.add('is-chosen');
          picks.hidden = true;
          q.value = btn.dataset.title;
        });
      });
    }, 220);
  });
}

function slotKey(ref) {
  const r = normalizeReference(ref);
  return String(r.id ?? `${r.sourceId}:${r.selector}:${r.key}`);
}

// Attribute-selector escaping without depending on CSS.escape being present.
function cssEscape(s) {
  return String(s).replace(/["\\]/g, '\\$&');
}

// Related pages — the same graph the answer engine expands along, surfaced on
// the page itself. Feature-detected separately from /ask and silent when the
// endpoint is not there.
async function renderRelatedPanel(pageId) {
  const host = document.getElementById('related-host');
  if (!host || state.features.related === false) return;
  let items;
  try {
    const r = await api('GET', `/pages/${pageId}/related`);
    state.features.related = true;
    items = (Array.isArray(r) ? r : (r?.related ?? r?.pages ?? r?.results ?? [])).map(normalizeCitation);
  } catch (err) {
    if (err.status === 404 || err.status === 405) state.features.related = false;
    return; // a nice-to-have never becomes noise
  }
  if (!items.length || !host.isConnected) return;
  host.innerHTML = `
    <section class="panel">
      <h2 class="h-small">Related in the record</h2>
      <ul class="related-list">
        ${items.map((it) => (it.pageId ? `
          <li><a class="related-link" href="#/pages/${esc(it.pageId)}">
            <span class="related-title">${esc(it.title)}</span>
            ${it.status ? badge(it.status, 'sm') : ''}
            ${it.version ? `<span class="citation-version">v${esc(it.version)}</span>` : ''}
          </a></li>` : '')).join('')}
      </ul>
    </section>`;
}

// ---------------------------------------------------------------------------
// Comments panel — feature-detected; degrades to nothing while the comments
// endpoints are still being built.

function normalizeComment(c) {
  return {
    id: c.id ?? c.commentId ?? null,
    body: c.body ?? c.text ?? c.content ?? '',
    authorId: c.authorId ?? c.actorId ?? c.author ?? null,
    createdAt: c.createdAt ?? c.at ?? null,
    resolved: Boolean(c.resolved ?? c.resolvedAt ?? false),
    // WHO resolved it and WHEN. The server has carried both since resolve was
    // written; the client dropped them, so "resolved" was a bare tag — a
    // conversation closed by nobody, at no time. On a record whose whole claim
    // is that you can see who decided what, that is the wrong kind of gap.
    resolvedAt: c.resolvedAt ?? null,
    resolvedBy: c.resolvedBy ?? null,
    // An approver's send-back reason is a comment (USER-TESTING.md T4.3), and
    // the most consequential sentence on the page should not read as an
    // ordinary remark. The server derives it from the event that recorded the
    // send-back; an older server says nothing and every comment reads plain.
    sentBack: c.sentBack === true,
  };
}

// `ability` is the server's answer about whether this actor may comment here,
// in `page.abilities.comment` shape, or null on a server that serves none. A
// refusal replaces the box with the reason rather than leaving a form that
// 403s at the last click (T4.4).
/**
 * A comment's resolution: who closed it and when, plus the way to close or
 * reopen it.
 *
 * `POST /comments/:id/resolve` and `/reopen` have existed since resolve was
 * written, and `resolved_at`/`resolved_by` are stored — but nothing rendered a
 * button, so the send-back banner's promise that a comment "can be replied to
 * and resolved" was half true: you could reply, and there was no way to
 * resolve. A conversation that cannot be closed is one that stays open on the
 * page forever, which is how a page ends up with a wall of remarks nobody can
 * tell the live ones from.
 *
 * Both routes take the `comment` role — the same one that let you write the
 * comment — so the gate the composer already computes is exactly the right
 * gate here, and a reader without it sees the state and no buttons.
 */
function commentResolutionHTML(c, canComment) {
  const who = c.resolvedBy ? actorLabel(c.resolvedBy) : null;
  const when = c.resolvedAt ? fmtDateTime(c.resolvedAt) : null;
  const provenance = c.resolved && (who || when)
    ? `<span class="muted comment-resolved-by">Resolved${who ? ` by ${who}` : ''}${when ? ` on ${esc(when)}` : ''}.</span>`
    : '';
  if (!canComment) return provenance ? `<div class="comment-actions">${provenance}</div>` : '';
  const button = c.resolved
    ? `<button class="btn subtle" type="button" data-reopen="${esc(c.id)}">Reopen</button>`
    : `<button class="btn subtle" type="button" data-resolve="${esc(c.id)}">Resolve</button>`;
  return `<div class="comment-actions">${provenance}${button}</div>`;
}

/**
 * Who this reader can mention, and how.
 *
 * `@<actorId>` was the only form the server accepted and an actor id is a
 * UUID — so "mention someone to bring them in", which the product describes as
 * a workflow, could not be performed by a person. The server now resolves a
 * member's NAME as well; this is the half that makes it discoverable, because
 * a feature nobody can see is not one.
 *
 * The list is the collection's members, which is exactly the set the server
 * will resolve and exactly the set a mention would reach — somebody outside it
 * is withheld anyway. So the names offered here can never be a promise the
 * server then breaks.
 */
function mentionHintHTML(people) {
  if (!people.length) return '';
  return `<p class="muted comment-mention-hint">Mention someone with <code>@</code>:
    ${people.map((p) => `<button type="button" class="btn subtle mention-chip"
      data-mention="${esc(p.name)}">@${esc(p.name)}</button>`).join(' ')}</p>`;
}

/** Clicking a name inserts it at the cursor — a hint you cannot act on is a
 *  smaller version of the same problem. */
function wireMentionChips(host) {
  const box = host.querySelector('#comment-form textarea');
  if (!box) return;
  for (const chip of host.querySelectorAll('.mention-chip')) {
    chip.addEventListener('click', () => {
      const insert = `@${chip.dataset.mention} `;
      const at = box.selectionStart ?? box.value.length;
      const end = box.selectionEnd ?? at;
      box.value = box.value.slice(0, at) + insert + box.value.slice(end);
      box.focus();
      const caret = at + insert.length;
      box.setSelectionRange(caret, caret);
    });
  }
}

/** The collection's members, as names. Empty on any failure: the composer is
 *  still usable without the hint, and a broken hint must not cost a comment. */
async function mentionableIn(collectionId) {
  if (!collectionId) return [];
  try {
    const rows = await api('GET', `/collections/${collectionId}/members`);
    const list = Array.isArray(rows) ? rows : (rows?.members ?? []);
    return list
      .map((m) => ({ id: m.actorId ?? m.actor_id, name: actorName(m.actorId ?? m.actor_id) }))
      // Not yourself: the server never notifies an author about their own
      // comment, so offering your own name would be a chip that does nothing.
      .filter((m) => m.id && m.name && m.name !== '—' && m.id !== state.actor?.id);
  } catch {
    return [];
  }
}

async function renderCommentsPanel(pageId, ability = null, collectionId = null) {
  const host = document.getElementById('comments-host');
  if (!host || state.features.comments === false) return;
  const mentionable = ability && ability.can === false ? [] : await mentionableIn(collectionId);
  let comments;
  try {
    const r = await api('GET', `/pages/${pageId}/comments`);
    state.features.comments = true;
    comments = (Array.isArray(r) ? r : (r?.comments ?? [])).map(normalizeComment);
  } catch (err) {
    if (err.status === 404) { state.features.comments = false; return; }
    host.innerHTML = `<section class="panel"><h2 class="h-small">Comments</h2>
      <p class="muted">Comments could not be loaded: ${esc(err.message)}</p></section>`;
    return;
  }
  // The same gate the composer uses: resolve and reopen both take `comment`.
  const canComment = !(ability && ability.can === false);
  host.innerHTML = `
    <section class="panel" id="comments-panel">
      <h2 class="h-small">Comments</h2>
      ${comments.length ? `
        <ul class="comment-list">
          ${comments.map((c) => `
            <li class="comment ${c.resolved ? 'resolved' : ''} ${c.sentBack ? 'comment-sentback' : ''}"
                id="comment-${esc(c.id)}">
              <div class="comment-meta">${actorLabel(c.authorId)}
                <span class="muted">${fmtDateTime(c.createdAt)}</span>
                ${c.sentBack ? '<span class="role-tag">sent this back</span>' : ''}
                ${c.resolved ? '<span class="role-tag">resolved</span>' : ''}</div>
              <div class="comment-body">${esc(c.body)}</div>
              ${commentResolutionHTML(c, canComment)}
            </li>`).join('')}
        </ul>` : '<p class="muted">No comments yet.</p>'}
      ${ability && !ability.can
        ? `<p class="muted">${esc(ability.why ?? 'You cannot comment on this page.')}</p>`
        : `<form id="comment-form" class="stack">
             <textarea name="body" rows="2" required placeholder="Add a comment…"></textarea>
             ${mentionHintHTML(mentionable)}
             <div><button class="btn" type="submit">Comment</button></div>
           </form>`}
    </section>`;
  wireMentionChips(host);
  for (const btn of host.querySelectorAll('[data-resolve], [data-reopen]')) {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.resolve ?? btn.dataset.reopen;
      const verb = btn.dataset.resolve ? 'resolve' : 'reopen';
      btn.disabled = true;
      try {
        await api('POST', `/comments/${id}/${verb}`);
        renderCommentsPanel(pageId, ability, collectionId);
      } catch (err) {
        btn.disabled = false;
        // A Canon that does not serve these routes is not a broken one — say
        // so once rather than leaving a button that silently does nothing.
        if (err.status === 404 || err.status === 405) {
          toast('Resolving a comment is not available on this Canon yet.', 'info');
        } else toastError(err);
      }
    });
  }
  host.querySelector('#comment-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = e.target.body.value.trim();
    if (!body) return;
    try {
      await api('POST', `/pages/${pageId}/comments`, { body });
      renderCommentsPanel(pageId, ability, collectionId);
    } catch (err) {
      if (err.status === 404 || err.status === 405) {
        state.features.comments = false;
        host.innerHTML = '';
        toast('Comments are not available yet.', 'info');
      } else toastError(err);
    }
  });
}

// ---------------------------------------------------------------------------
// Editor
//
// THE TOOLBAR OFFERS EXACTLY WHAT THE RENDERER DRAWS, and nothing else. A
// button for something renderMarkdown cannot draw is a promise the page then
// breaks in front of the reader, which is worse than having no button: the
// writer has no way to find out that the thing they were offered does not
// work until twelve people are looking at it. So this list and the block
// grammar above are one list, and the Table button is here because typing
// pipe syntax by hand is precisely what the person who reported T4.1 could
// not do.
//
// The buttons write through document.execCommand('insertText') where it
// exists, which is deprecated and still the only way to insert text into a
// textarea WITHOUT destroying the browser's own undo stack. A writer who
// clicks Table and then presses Ctrl-Z expects the table to go away, not the
// last twenty minutes. Where it is unavailable the fallback writes the value
// directly and the button still works; only undo is coarser.

const MD_TOOLS = [
  { key: 'h2', label: 'Heading', title: 'Heading — ## text' },
  { key: 'bold', label: 'Bold', title: 'Bold — **text**' },
  { key: 'italic', label: 'Italic', title: 'Italic — *text*' },
  { key: 'ul', label: 'List', title: 'Bulleted list — - item' },
  { key: 'ol', label: 'Numbered', title: 'Numbered list — 1. item' },
  { key: 'table', label: 'Table', title: 'Table — a three-column skeleton to fill in' },
  { key: 'link', label: 'Link', title: 'Link — [text](https://…)' },
  { key: 'quote', label: 'Quote', title: 'Quotation — > text' },
  { key: 'code', label: 'Code', title: 'Inline code — `text`' },
  { key: 'rule', label: 'Rule', title: 'Horizontal rule — ---' },
];

// A skeleton, not an empty grid: a person filling in a retention schedule
// needs to see where the header row, the alignment row and the data rows go,
// and the placeholder words are what makes that legible before it is filled in.
const MD_TABLE_SKELETON = [
  '| Column 1 | Column 2 | Column 3 |',
  '| --- | --- | --- |',
  '| Row 1 | | |',
  '| Row 2 | | |',
].join('\n');

function mdEditorTools(ta) {
  // One write path, so undo behaves the same whichever button was pressed.
  const write = (text, selectFrom, selectTo) => {
    ta.focus();
    let inserted = false;
    try { inserted = document.execCommand('insertText', false, text); } catch { inserted = false; }
    if (!inserted) {
      ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (selectFrom !== undefined) {
      const base = ta.selectionEnd - text.length;
      ta.setSelectionRange(base + selectFrom, base + (selectTo ?? selectFrom));
    }
  };

  // Wrap the selection, or drop in a placeholder and select it so the next
  // keystroke replaces it.
  const wrap = (before, after, placeholder) => {
    const chosen = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    const text = chosen || placeholder;
    write(before + text + after, before.length, before.length + text.length);
  };

  // Prefix every line the selection touches. `prefix` may be a function so a
  // numbered list counts.
  const prefixLines = (prefix, placeholder) => {
    const start = ta.value.lastIndexOf('\n', ta.selectionStart - 1) + 1;
    let end = ta.value.indexOf('\n', ta.selectionEnd);
    if (end === -1) end = ta.value.length;
    const at = (n) => (typeof prefix === 'function' ? prefix(n) : prefix);
    const lines = ta.value.slice(start, end).split('\n');
    const empty = lines.length === 1 && lines[0].trim() === '';
    const body = empty ? [placeholder] : lines;
    const text = body.map((line, n) => at(n) + line).join('\n');
    ta.setSelectionRange(start, end);
    write(text, empty ? at(0).length : 0, empty ? at(0).length + placeholder.length : text.length);
  };

  // A block of its own, with whatever blank lines it needs to be one.
  const block = (text, selectFrom, selectTo) => {
    const before = ta.value.slice(0, ta.selectionStart);
    const after = ta.value.slice(ta.selectionEnd);
    const lead = before === '' || /\n\n$/.test(before) ? '' : /\n$/.test(before) ? '\n' : '\n\n';
    const trail = after.startsWith('\n') ? '\n' : '\n\n';
    write(lead + text + trail, lead.length + selectFrom, lead.length + selectTo);
  };

  return {
    h2: () => prefixLines('## ', 'Heading'),
    bold: () => wrap('**', '**', 'bold text'),
    italic: () => wrap('*', '*', 'italic text'),
    ul: () => prefixLines('- ', 'List item'),
    ol: () => prefixLines((n) => `${n + 1}. `, 'List item'),
    quote: () => prefixLines('> ', 'Quoted text'),
    code: () => wrap('`', '`', 'code'),
    link: () => {
      const chosen = ta.value.slice(ta.selectionStart, ta.selectionEnd) || 'link text';
      const text = `[${chosen}](https://)`;
      // The caret lands after "https://", where the address goes.
      write(text, text.length - 1, text.length - 1);
    },
    table: () => block(MD_TABLE_SKELETON, 2, 10), // "Column 1" selected
    rule: () => block('---', 3, 3),
  };
}

// WHAT THE PAGE WILL BE WHEN THIS IS DONE.
//
// The Publish dialog used to say what publishing is NOT — "it publishes
// without review — use 'Submit for review' if this page should earn the
// Canonical mark" — and never once said where the page ends up. A new
// contributor, second round of user testing: "I nearly pressed it, and I'd
// have had no idea what I'd done."
//
// It ends up a Draft. Every type, every time: `writeVersion` in store.ts
// settles the status to `draft` unless an approval is what wrote the version,
// because the Canonical mark applies to reviewed content and nothing here has
// been reviewed. So that is the first sentence, in the same word and the same
// badge the page will wear afterwards, carrying the sentence the status key
// gives that badge everywhere else — somebody who has learned what DRAFT means
// in this product must not have to learn it again from a dialog.
//
// The version number is named too. "The current version for every reader" was
// true and abstract; "v4, and that is what every reader then sees" is the same
// fact somebody can check on the History screen afterwards.
//
// Giving up a mark the page already holds is the third sentence and only
// appears when there is one to give up. The editor says this at the top of the
// screen as well; it is repeated here because this is where the decision is
// taken, and a warning somebody scrolled past on the way in is not a warning.
function publishDialogBodyHTML(page, reviewed) {
  const nextVersion = (page.currentVersion ?? 0) + 1;
  const heldMark = page.status === 'canonical' || page.status === 'needs_update';
  // The two roads, each described by what it DOES. "Use Submit for review
  // instead" used to be advice the product then refused to take — submit
  // rejected a Canonical page, so the only real road was the publish this
  // dialog argued against (third round, finding 8). Now that the advice is
  // followable, the dialog states the trade plainly: publish is immediate and
  // unreviewed; submit changes nothing a reader sees until an approver
  // accepts.
  const noReview = reviewed
    ? 'Publishing is not review, and it grants no standing: this text goes live for every reader immediately, ' +
      'with nobody’s agreement on it. <strong>Submit for review</strong> is the other road — nothing a ' +
      'reader sees changes until the approver accepts, and only then does the Canonical mark cover the new text.'
    : 'A Note publishes directly and never carries the Canonical mark, so this is as far as it goes — there ' +
      'is no review to send it to.';
  const giveUp = heldMark
    ? `<p class="notice notice-stale">This page is ${esc(STATUS_LABELS[page.status] ?? page.status)} today, and
       publishing gives that up: the mark applies to reviewed content, so the page stops answering for the
       record until it passes review again. Submitting the draft for review instead keeps the approved
       version serving — and answering — for the whole review.</p>`
    : '';
  return `
    <p>Publishing writes <strong>v${nextVersion}</strong> and makes it the version every reader of this page
      sees. The page is then a ${badge('draft')}:
      <span class="muted">${esc(STATUS_MEANINGS.draft)}</span></p>
    <p class="muted">${noReview}</p>
    ${giveUp}
    <label>Version note <input name="note" placeholder="optional, kept in version history"></label>`;
}

/** The approve-holders of a collection, or null where the membership cannot be read. */
async function loadApproveHolders(collectionId) {
  try {
    const members = await api('GET', `/collections/${collectionId}/members`);
    return members.filter((m) => ROLES.indexOf(m.role) >= ROLES.indexOf('approve'));
  } catch { return null; }
}

// WHO MAY BE NAMED AS THE APPROVER, wherever an approver is named.
//
// `approve` accepts only somebody holding the approve role on the collection,
// so a picker drawn from the whole directory offers names the server will
// refuse: a contributor once named the senior colleague she would actually
// have walked over to, and the page sat waiting on somebody who could not
// act, with Approve greyed for the person named and an empty queue for
// everybody else. One options builder, shared by the editor's field and the
// submit confirmation, because two pickers with two membership rules would
// reopen exactly that gap on whichever screen kept the old one.
//
// A null holder list — the membership could not be read, a rare view-only
// edge — falls back to the full directory rather than offering nothing: an
// empty approver list is a worse dead end than a wrong name.
function approverOptionsHTML(approvers, selected) {
  const people = state.actors ?? [];
  const nameOf = (id) => people.find((a) => a.id === id)?.name;
  if (!approvers) {
    return `<option value="">—</option>` + people.map((a) =>
      `<option value="${esc(a.id)}" ${a.id === selected ? 'selected' : ''}>${esc(a.name)}${a.kind === 'agent' ? ' (agent)' : ''}</option>`).join('');
  }
  const named = approvers.map((m) => ({ id: m.actorId, name: nameOf(m.actorId) ?? m.actorName ?? m.actorId }));
  // Somebody already named who has since lost the role stays in the list, so
  // the page does not silently forget who it was waiting on.
  if (selected && !named.some((n) => n.id === selected)) {
    named.push({ id: selected, name: `${nameOf(selected) ?? selected} (no longer holds approve)` });
  }
  return `<option value="">—</option>` + named.map((n) =>
    `<option value="${esc(n.id)}" ${n.id === selected ? 'selected' : ''}>${esc(n.name)}</option>`).join('');
}

// WHAT THE SUBMIT CONFIRMATION SAYS, and why it exists at all. Submitting used
// to be one unconfirmed click, and the one fact that click commits to — WHO
// will be asked to sign — was set on a field several screens back that nothing
// restated; Priya submitted to the wrong approver and found out days later
// (third round, finding 9). So the confirmation shows the named approver at
// the moment of commitment and lets it be corrected there, from the same
// approve-holders list the editor offers. Types that name no approver get the
// plain sentence about who will act instead: confirming is still worth a
// click, inventing a select the type has no field for is not.
function submitDialogBodyHTML(namesApprover, optionsHTML) {
  if (!namesApprover) {
    return `
      <p>Submitting locks the draft and puts it in front of this collection's approvers. This page's type
        names no single approver, so any of them may accept it or send it back.</p>`;
  }
  return `
    <p>Submitting locks the draft and puts it in front of the approver named below. <strong>Nobody else can
      accept it</strong> — the wrong name here leaves the page waiting on somebody who may never look.</p>
    <label>Approver <select name="approverId" required>${optionsHTML}</select></label>
    <p class="muted">Only holders of the approve role here can be named. Changing the name writes it into
      the draft as part of submitting, so the review will be waiting on exactly the person shown.</p>`;
}

// The one road into POST /pages/:id/submit from either screen that offers it.
// The choice made in the dialog IS the draft's named approver: it is written
// into the draft before the submission, so the server's reviewState, the
// in-review banner and this dialog can only ever name the same person.
async function openSubmitReviewDialog(page, draftFields, afterSubmit) {
  const namesApprover = Boolean((TYPE_FIELDS[page.type] ?? {}).approver);
  const approvers = namesApprover ? await loadApproveHolders(page.collectionId) : null;
  const current = draftFields?.approverId ?? null;
  openModal({
    title: 'Submit for review',
    submitLabel: 'Submit for review',
    body: submitDialogBodyHTML(namesApprover, namesApprover ? approverOptionsHTML(approvers, current) : ''),
    onSubmit: async (form) => {
      if (namesApprover) {
        const chosen = form.approverId.value || null;
        if (chosen !== current) {
          await api('PUT', `/pages/${page.id}/draft`, { fields: { approverId: chosen } });
        }
      }
      const submitted = await api('POST', `/pages/${page.id}/submit`);
      toast('Submitted for review.', 'ok');
      raiseLinkWarnings(submitted);
      afterSubmit();
    },
  });
}

// The server's alias bounds, restated so the editor can warn BEFORE a save is
// attempted. The server refuses an out-of-bounds list atomically — the whole
// save, every pending field, not just the aliases (store.ts validateFieldShape)
// — and a policy owner lost twenty minutes of edits to a toast she never saw.
// The numbers must match CanonStore.MAX_ALIASES and its per-name cap; a drift
// here only makes the warning early or late, never the save wrong, because the
// server still decides.
const ALIAS_MAX_NAMES = 20;
const ALIAS_MAX_LENGTH = 64;
// When the counter appears: early enough to see the ceiling coming, late
// enough that a three-name list is not decorated with arithmetic.
const ALIAS_COUNTER_FROM = 15;

/**
 * What the "Also known as" input should say about itself as it is typed:
 * a counter once the list approaches the ceiling, and the refusal the server
 * WILL give — named now, while the words are still under the editor's cursor —
 * once a name is too long or the list too large.
 */
function aliasFieldNotice(value) {
  const names = String(value ?? '').split(',').map((a) => a.trim()).filter(Boolean);
  const problems = [];
  for (const name of names) {
    if (name.length > ALIAS_MAX_LENGTH) {
      problems.push(`“${name.slice(0, 24)}…” is ${name.length} characters — an alias is a short name of at most ${ALIAS_MAX_LENGTH}. Saving will fail until it is shortened.`);
    }
  }
  if (names.length > ALIAS_MAX_NAMES) {
    problems.push(`${names.length} names — a page carries at most ${ALIAS_MAX_NAMES}. Saving will fail until the list is back under that.`);
  }
  const counter = names.length >= ALIAS_COUNTER_FROM ? `${names.length} of ${ALIAS_MAX_NAMES} names` : '';
  return { counter, problems };
}

/**
 * The collision warnings a save came back with, rendered under the field that
 * earned them. A warning and deliberately not a refusal: two pages sometimes
 * share vocabulary on purpose, and the person reading this sentence is the
 * only one who knows whether this is that case. Persistent — it re-renders on
 * every save rather than fading — because a mis-steered search stays
 * mis-steered for as long as the name is shared.
 */
/**
 * WHAT THE AUTHOR IS TOLD ABOUT WHO CAN FOLLOW THEIR LINKS.
 *
 * Policy question 3, Canon's half. `withheldLinks` already stops a link's
 * LABEL reaching a reader who may not open the target — but the sentence
 * around the link is prose, and prose is the author's. "As set out in the
 * workforce reduction plan" gives away exactly what the withheld label was
 * protecting, and no permission check will ever find it.
 *
 * So the author is told the fact and left with the judgement: how many of the
 * people who can read this page cannot open that link. It is persistent for
 * the same reason the alias collisions are — the condition does not go away
 * when the notice does — and it is never a block, because a cross-collection
 * link is a normal, useful thing and a product that refuses one is a product
 * that stops people writing down what is true.
 */
function linkWarningsHTML(warnings) {
  if (!Array.isArray(warnings) || warnings.length === 0) return '';
  return `<p class="notice notice-stale link-audience">${warnings.map((w) => esc(w)).join('<br>')}</p>`;
}

/** The same sentences, after the act, where the editor is no longer on screen. */
function raiseLinkWarnings(response) {
  const warnings = response?.linkWarnings;
  if (!Array.isArray(warnings) || warnings.length === 0) return;
  for (const w of warnings) toast(w, 'warn');
}

function aliasWarningsHTML(warnings) {
  if (!Array.isArray(warnings) || warnings.length === 0) return '';
  return `<p class="notice notice-stale alias-collision">${warnings.map((w) => esc(w)).join('<br>')}<br>
    A shared name steers search and Ask toward both pages. Keep it only if both should answer to it.</p>`;
}

/**
 * The two sentences a failed save leaves on screen. Both matter: the alert is
 * the persistent trace (the toast dies in seconds, and a save that failed must
 * not go on looking like a save that happened), and the save-state line is
 * corrected in place because "Draft saved 14:02" standing next to work the
 * server refused is the exact lie that lost an editor her afternoon.
 */
function editorSaveFailure(err) {
  const why = err.status === 423
    ? `This page is being edited by ${err.details?.editorName ?? 'someone else'}.`
    : (err.message || 'The server refused the save.');
  return {
    alert: `This draft is NOT saved. ${why}`,
    saveState: 'Saving failed — nothing was stored. Fix the field named above and save again.',
  };
}

async function viewEditor(id) {
  const page = await api('GET', `/pages/${id}`);
  await loadActors().catch(() => null);
  // The sentence under the review-date field is a promise about this
  // deployment, so it waits for the answer rather than guessing (freshnessPromise).
  await detectFreshness().catch(() => null);
  let draft;
  try {
    // An empty PUT is the editor's opening question, and the server treats it
    // as one: it answers with the held draft or the seed, and the lock
    // refusal where somebody else is editing — and it WRITES NOTHING. Walking
    // in the door used to create the draft row, which put an untyped "draft"
    // in the queue and the audit log and locked out every other editor
    // (fourth round, finding 4). The lock is taken by the first real change,
    // below.
    draft = await api('PUT', `/pages/${id}/draft`, {});
  } catch (err) {
    if (err.status === 423) {
      const editor = err.details?.editorName ?? actorName(err.details?.editorId);
      app.innerHTML = `
        <div class="page-narrow">
          <div class="empty-state">
            <h2>Being edited by ${esc(editor)}</h2>
            <p>${esc(err.message)}. Canon keeps drafts to one editor at a time, so
            nothing is overwritten. Try again once they publish or discard.</p>
            <p>
              <a class="btn" href="#/pages/${esc(id)}">Back to page</a>
              <button class="btn" id="retry-lock">Try again</button>
            </p>
          </div>
        </div>`;
      app.querySelector('#retry-lock').addEventListener('click', () => render(() => viewEditor(id)));
      return;
    }
    if (err.status === 422) {
      app.innerHTML = `
        <div class="page-narrow">
          <div class="empty-state">
            <h2>Not editable right now</h2>
            <p>${esc(err.message)}</p>
            <p><a class="btn" href="#/pages/${esc(id)}">Back to page</a></p>
          </div>
        </div>`;
      return;
    }
    throw err;
  }

  const rules = TYPE_FIELDS[page.type] ?? {};
  const reviewed = REVIEWED_TYPES.includes(page.type);
  const people = state.actors ?? [];
  const actorOptions = (selected) => `<option value="">—</option>` + people.map((a) =>
    `<option value="${esc(a.id)}" ${a.id === selected ? 'selected' : ''}>${esc(a.name)}${a.kind === 'agent' ? ' (agent)' : ''}</option>`).join('');

  // Approve-holders only — approverOptionsHTML owns the argument, and it is
  // the same builder the submit confirmation draws from, so the field where an
  // approver is first named and the dialog where the naming is committed to
  // can never offer different people.
  const approvers = await loadApproveHolders(page.collectionId);
  const approverOptions = (selected) => approverOptionsHTML(approvers, selected);

  app.innerHTML = `
    <div class="page-wide editor">
      <p class="breadcrumb"><a href="#/pages/${esc(id)}">← Back to page</a></p>
      <div class="page-head">
        <h1>Editing <span class="muted">(${esc(TYPE_LABELS[page.type])})</span></h1>
        <span id="save-state" class="muted"></span>
      </div>
      ${/* The persistent trace of a failed save. The toast is transient by
            design, and a refusal that lives only in a toast is a refusal the
            editor can miss — after which "Draft saved 14:02" above keeps
            vouching for work the server threw away. This region holds the
            server's own sentence until a save actually succeeds. */ ''}
      <p id="editor-alert" class="notice editor-alert" role="alert" aria-live="assertive" hidden></p>
      ${page.status === 'canonical' ? `
        <div class="notice">This page is Canonical. <strong>Submit for review</strong> keeps it that way —
        readers and Ask keep the approved version until the approver accepts your changes. Publishing
        instead makes the new text live at once and gives the mark up until it passes review again.</div>` : ''}
      <form id="editor-form" class="editor-grid">
        <div class="editor-mainCol">
          <label>Title <input name="title" required maxlength="200" value="${esc(draft.title)}"></label>
          <label class="editor-bodyLabel" for="ed-body">Body</label>
          <div class="md-toolbar" role="toolbar" aria-label="Formatting" aria-controls="ed-body">
            ${MD_TOOLS.map((t) =>
              `<button type="button" class="md-btn" data-md="${esc(t.key)}" title="${esc(t.title)}">${esc(t.label)}</button>`).join('')}
            <span class="md-toolbar-gap"></span>
            <button type="button" class="md-btn md-btn-mode" id="ed-preview-toggle" aria-pressed="false">Preview</button>
          </div>
          <textarea id="ed-body" name="body" class="editor-body" spellcheck="true">${esc(draft.body)}</textarea>
          <div id="ed-preview" class="doc-body editor-preview" hidden></div>
          <p class="muted md-hint">The buttons insert everything the page can draw:
            <code># headings</code>, <code>**bold**</code>, <code>*italic*</code>, <code>- lists</code>,
            <code>1. lists</code>, <code>\`code\`</code>, fenced blocks,
            <code>[links](https://…)</code>, <code>&gt; quotes</code>, <code>---</code> rules
            and <code>| pipe | tables |</code>. <strong>Preview</strong> shows the page exactly as a
            reader will meet it.</p>
        </div>
        <div class="editor-sideCol">
          <div class="panel">
            <h2 class="h-small">Fields</h2>
            ${rules.owner ? `<label>Owner <select name="ownerId">${actorOptions(draft.fields.ownerId)}</select></label>` : ''}
            ${rules.approver ? `<label>Approver <select name="approverId">${approverOptions(draft.fields.approverId)}</select></label>
            <p class="muted">${approvers ? `Only ${approvers.length === 1 ? 'the one person' : `the ${approvers.length} people`} who hold the approve role here can be named.` : 'Naming somebody without the approve role on this collection will leave the page waiting on somebody who cannot act.'}</p>` : ''}
            ${rules.effectiveDate ? `<label>Effective date <input type="date" name="effectiveDate" value="${esc(draft.fields.effectiveDate ?? '')}"></label>
            ${/* A date earlier than the page's own first publication is usually
                  legitimate — a policy adopted before Canon existed — but the
                  record cannot corroborate it, so the person asserting it says
                  where it comes from (USER-TESTING.md T1.5). The server refuses
                  the save without this; the field is here so that refusal is
                  something a policy owner can act on rather than a dead end. */ ''}
            <label>Where the effective date comes from <span class="muted">(required if it pre-dates this record)</span>
              <input type="text" name="effectiveDateBasis" value="${esc(draft.fields.effectiveDateBasis ?? '')}"
                placeholder="e.g. Adopted by the Clinical Governance Committee, minute CGC-2018-11-14"></label>` : ''}
            ${rules.reviewDate ? `<label>Review date${rules.reviewDateRequired ? ' <span class="muted">(required)</span>' : ''} <input type="date" name="reviewDate" value="${esc(draft.fields.reviewDate ?? '')}"></label>
            <p class="${state.features.freshness && !state.features.freshness.scheduled ? 'notice notice-stale' : 'muted'}">${freshnessPromise()}</p>` : ''}
            ${/* The words people actually use for this page's subject, next to
                  the title they search-and-ask in. "urgent" beside a page that
                  says "expedited" is the difference between that question being
                  answered and being refused — see the refused-questions view,
                  which is where the missing words come from. The placeholder
                  and the help line are collection-neutral on purpose: a new
                  joiner in HR was shown claims examples and read the field as
                  not for her (third round, Ada).

                  The help line states the two moments precisely, because its
                  previous sentence promised approval before any effect — and
                  that was false in the half that matters: a published alias
                  steers SEARCH at once, with the page's standing badged on
                  the result so nothing passes as official; only the record's
                  official answers wait for the Canonical mark (fourth round,
                  Ruth and Priya). */ ''}
            <label>Also known as <span class="muted">(comma-separated)</span>
              <input type="text" name="aliases" value="${esc((draft.fields.aliases ?? []).join(', '))}"
                placeholder="other names people use for this subject"></label>
            <p class="muted type-help">Searchable names people actually use for what this page covers.
              They steer search to this page as soon as they publish, badged with the page's standing;
              the record's official answers use them only while the page holds the Canonical mark.</p>
            <p id="alias-live" class="muted type-help" aria-live="polite"></p>
            <div id="alias-warnings" aria-live="polite"></div>
            <div id="link-warnings" aria-live="polite"></div>
            ${!rules.owner && !rules.approver && !rules.effectiveDate && !rules.reviewDate ? '<p class="muted">A Note carries no required fields.</p>' : ''}
          </div>
          <div id="editor-refs"></div>
          <div class="panel editor-actions">
            <button class="btn primary" type="submit">Save draft</button>
            <button class="btn" type="button" id="ed-publish">Publish…</button>
            ${reviewed ? '<button class="btn" type="button" id="ed-submit">Submit for review</button>' : ''}
            <button class="btn danger-subtle" type="button" id="ed-discard">Discard draft</button>
          </div>
        </div>
      </form>
    </div>`;

  const form = app.querySelector('#editor-form');
  const saveState = app.querySelector('#save-state');
  const editorAlert = app.querySelector('#editor-alert');

  // The alias bounds, said while they are being typed rather than after the
  // save they would sink (aliasFieldNotice). The server still decides; this
  // only moves the sentence to before the click.
  const aliasLive = app.querySelector('#alias-live');
  const syncAliasNotice = () => {
    const { counter, problems } = aliasFieldNotice(form.aliases.value);
    aliasLive.textContent = problems.length ? problems.join(' ') : counter;
    aliasLive.classList.toggle('alias-problem', problems.length > 0);
  };
  form.aliases.addEventListener('input', syncAliasNotice);
  syncAliasNotice();
  // The opening probe already answered for the names the draft (or its seed)
  // carries, so a collision that predates this editing session is on screen
  // from the first paint rather than after the first save.
  app.querySelector('#alias-warnings').innerHTML = aliasWarningsHTML(draft.warnings);
  app.querySelector('#link-warnings').innerHTML = linkWarningsHTML(draft.linkWarnings);

  // The toolbar and the preview. The preview is the same renderMarkdown() the
  // page view uses, inside the same .doc-body, because a preview that renders
  // by any other route is a preview that can disagree with the page — and the
  // whole complaint (T4.1) was not knowing what was about to be published.
  const bodyEl = form.querySelector('#ed-body');
  const preview = form.querySelector('#ed-preview');
  const previewToggle = form.querySelector('#ed-preview-toggle');
  const tools = mdEditorTools(bodyEl);
  form.querySelectorAll('.md-toolbar [data-md]').forEach((btn) => {
    btn.addEventListener('click', () => tools[btn.dataset.md]?.());
  });
  let previewing = false;
  previewToggle.addEventListener('click', () => {
    previewing = !previewing;
    if (previewing) {
      preview.innerHTML = renderMarkdown(bodyEl.value) ||
        '<p class="muted">Nothing written yet.</p>';
    }
    preview.hidden = !previewing;
    bodyEl.hidden = previewing;
    previewToggle.textContent = previewing ? 'Write' : 'Preview';
    previewToggle.setAttribute('aria-pressed', String(previewing));
    // A formatting button with nowhere to write is a button that lies.
    form.querySelectorAll('.md-toolbar [data-md]').forEach((btn) => { btn.disabled = previewing; });
    if (!previewing) bodyEl.focus();
  });

  const gather = () => {
    const fields = {};
    if (rules.owner) fields.ownerId = form.ownerId.value || null;
    if (rules.approver) fields.approverId = form.approverId.value || null;
    if (rules.effectiveDate) {
      fields.effectiveDate = form.effectiveDate.value || null;
      fields.effectiveDateBasis = form.effectiveDateBasis.value.trim() || null;
    }
    if (rules.reviewDate) fields.reviewDate = form.reviewDate.value || null;
    fields.aliases = form.aliases.value.split(',').map((a) => a.trim()).filter(Boolean);
    return { title: form.title.value.trim(), body: form.body.value, fields };
  };

  const save = async () => {
    const d = await api('PUT', `/pages/${id}/draft`, gather());
    // Only a save that happened may say so — and it also retires whatever a
    // failed one left standing, because the alert's claim ("NOT saved") has
    // just stopped being true.
    editorAlert.hidden = true;
    editorAlert.textContent = '';
    saveState.textContent = `Draft saved ${fmtDateTime(d.updatedAt)}`;
    // What the save came back with about shared vocabulary, under the field
    // it is about — replaced wholesale each save, so a collision the editor
    // just removed stops being claimed.
    app.querySelector('#alias-warnings').innerHTML = aliasWarningsHTML(d.warnings);
    app.querySelector('#link-warnings').innerHTML = linkWarningsHTML(d.linkWarnings);
    return d;
  };

  // The first real change is what takes the page lock. Opening created
  // nothing (see the probe above), so until somebody types, two people can
  // have the same editor open in peace; the first keystroke saves what the
  // form holds, which creates the draft and locks it. Somebody who lost that
  // race gets the same clearly-worded refusal a failed save gets — the alert
  // region below the title, naming who holds the page — instead of a lock
  // screen for a page they never touched. Tried once, not per keystroke: if
  // the claim fails, the explicit Save is the retry, with the alert already
  // saying why it will not succeed until the other editor is done.
  let lockClaimed = false;
  const claimLockOnFirstChange = () => {
    if (lockClaimed) return;
    lockClaimed = true;
    save().catch((err) => handleEditError(err));
  };
  form.addEventListener('input', claimLockOnFirstChange);
  form.addEventListener('change', claimLockOnFirstChange);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await save(); toast('Draft saved.', 'ok'); } catch (err) { handleEditError(err); }
  });

  app.querySelector('#ed-publish').addEventListener('click', async () => {
    openModal({
      title: 'Publish this draft',
      submitLabel: 'Publish',
      body: publishDialogBodyHTML(page, reviewed),
      onSubmit: async (mform) => {
        // A failed save here surfaces twice on purpose: the modal shows the
        // sentence (it is where the click happened), and the editor behind it
        // is marked failed too — cancelling the dialog must not land the
        // editor back on a stale "Draft saved …".
        try { await save(); } catch (err) { markSaveFailed(err); throw err; }
        const published = await api('POST', `/pages/${id}/publish`, mform.note.value.trim() ? { note: mform.note.value.trim() } : {});
        toast('Published.', 'ok');
        // After the navigation, and persistent: the editor that was showing
        // this is gone, and the page the author lands on has no reason to say
        // it. Publishing is the moment the text stops being theirs alone.
        raiseLinkWarnings(published);
        location.hash = `#/pages/${id}`;
      },
    });
  });

  app.querySelector('#ed-submit')?.addEventListener('click', async () => {
    // The draft is saved first — the dialog names the approver the draft
    // actually carries, not the one the form held before an unsaved edit —
    // and then the same confirmation as the page view's Submit, because two
    // roads into review with different ceremonies means the shortcut wins.
    try {
      const d = await save();
      await openSubmitReviewDialog(page, d.fields, () => { location.hash = `#/pages/${id}`; });
    } catch (err) { handleEditError(err); }
  });

  app.querySelector('#ed-discard').addEventListener('click', () => openModal({
    title: 'Discard this draft',
    submitLabel: 'Discard',
    danger: true,
    body: '<p>Unsaved and saved draft changes are thrown away; the published version is untouched. Continue?</p>',
    onSubmit: async () => {
      await api('DELETE', `/pages/${id}/draft`);
      toast('Draft discarded.', 'ok');
      location.hash = `#/pages/${id}`;
    },
  }));

  function markSaveFailed(err) {
    const failure = editorSaveFailure(err);
    editorAlert.textContent = failure.alert;
    editorAlert.hidden = false;
    saveState.textContent = failure.saveState;
  }

  function handleEditError(err) {
    // The toast still announces the failure; it just stopped being the only
    // trace of it. What persists is the alert region and a corrected
    // save-state line (editorSaveFailure) — the two places an editor looks
    // before deciding it is safe to navigate away.
    markSaveFailed(err);
    if (err.status === 423) {
      toast(`This page is being edited by ${err.details?.editorName ?? 'someone else'}.`, 'error');
    } else toastError(err);
  }

  renderEditorReferences(id, page.collectionId);
}

// ---------------------------------------------------------------------------
// Authoring references — POST /pages/:id/references, DELETE /references/:id.
// Feature-detected off the same two endpoints as the reader-side block: with
// no /sources and no resolver there is nothing to reference, and the panel is
// simply not there.

async function renderEditorReferences(pageId, collectionId) {
  const host = document.getElementById('editor-refs');
  if (!host) return;
  let refs = [];
  try {
    const r = await api('GET', `/pages/${pageId}/references`);
    state.features.references = true;
    refs = (Array.isArray(r) ? r : (r?.references ?? [])).map(normalizeReference);
  } catch (err) {
    if (err.status === 404 || err.status === 405) { state.features.references = false; return; }
    return; // a resolver hiccup is not a reason to offer authoring it cannot serve
  }
  const sourcesById = await loadSourcesById();
  if (!sourcesById || !host.isConnected) return; // no registered sources: nothing to reference

  const sources = [...sourcesById.values()].filter((s) => {
    const scope = sourceScopeIds(s);
    return !scope.length || scope.includes(collectionId);
  });

  host.innerHTML = `
    <div class="panel">
      <h2 class="h-small">Federated values</h2>
      <p class="muted editor-ref-note">Values Canon resolves from another system when this page is
        read. They are page-level and take effect immediately — they are not part of this draft.</p>
      ${refs.length ? `
        <ul class="editor-ref-list">
          ${refs.map((r) => `
            <li class="editor-ref">
              <span class="editor-ref-main">
                <span class="editor-ref-label">${esc(referenceLabel(r))}</span>
                <span class="muted editor-ref-src">${esc(clip(r.sourceName || sourcesById.get(r.sourceId)?.name || r.sourceId || 'unknown source', 40))}${resolveAuthMode(r, sourcesById) === 'service' ? ' · service-resolved' : ''}</span>
              </span>
              <button type="button" class="btn subtle" data-drop-ref="${esc(r.id)}"
                title="Remove this reference">Remove</button>
            </li>`).join('')}
        </ul>` : '<p class="muted">No federated values on this page.</p>'}
      ${sources.length
        ? '<button type="button" class="btn" id="add-ref">Add a federated value</button>'
        : '<p class="muted">No source is referenceable from this collection.</p>'}
    </div>`;

  const reload = () => renderEditorReferences(pageId, collectionId);
  const gone = (err) => {
    if (err.status !== 404 && err.status !== 405) return false;
    state.features.references = false;
    host.innerHTML = '';
    toast('Authoring federated values is not available yet.', 'info');
    return true;
  };

  host.querySelector('#add-ref')?.addEventListener('click', () => {
    openModal({
      title: 'Add a federated value',
      submitLabel: 'Add reference',
      body: `
        <p class="muted">Canon will not store this value. It holds the key below and asks the source
          for the value every time the page is read, showing what answered and when.</p>
        <label>Source
          <select name="sourceId" required>
            ${sources.map((s) => `<option value="${esc(s.id)}" data-mode="${esc(s.authMode ?? 'per_asker')}">${esc(s.name)} (${esc(s.kind ?? 'source')})</option>`).join('')}
          </select>
        </label>
        <div class="notice notice-locked" data-service-warn hidden>
          This source is resolved with a service identity: the value will be visible to everyone who
          can view this collection, whatever the source system itself would have allowed them to see.
        </div>
        <label>Selector <input name="selector" required maxlength="120" placeholder="e.g. in_network_deductible"></label>
        <label>Key <input name="key" required maxlength="200" placeholder="the identifier this page already carries, e.g. PLAN-4471"></label>
        <label>Label <input name="label" maxlength="120" placeholder="how it reads on the page (optional)"></label>`,
      onSubmit: async (form) => {
        try {
          await api('POST', `/pages/${pageId}/references`, {
            sourceId: form.sourceId.value,
            selector: form.selector.value.trim(),
            key: form.key.value.trim(),
            ...(form.label.value.trim() ? { label: form.label.value.trim() } : {}),
          });
        } catch (err) { if (gone(err)) return; throw err; }
        toast('Reference added.', 'ok');
        reload();
      },
    });
    const form = document.querySelector('#modal-root form');
    const warn = form.querySelector('[data-service-warn]');
    const sync = () => { warn.hidden = form.sourceId.selectedOptions[0]?.dataset.mode !== 'service'; };
    form.sourceId.addEventListener('change', sync);
    sync();
  });

  host.querySelectorAll('[data-drop-ref]').forEach((btn) => {
    btn.addEventListener('click', () => openModal({
      title: 'Remove this federated value',
      submitLabel: 'Remove',
      danger: true,
      body: `<p>The page will stop asking for this value. Nothing in the source system changes.
        Continue?</p>`,
      onSubmit: async () => {
        try {
          await api('DELETE', `/references/${btn.dataset.dropRef}`);
        } catch (err) { if (gone(err)) return; throw err; }
        toast('Reference removed.', 'ok');
        reload();
      },
    }));
  });
}

// ---------------------------------------------------------------------------
// Version history

// A VERSION NOTE IS NEVER EDITED, EVEN WHEN IT IS WRONG.
//
// Round seven, policy question 4. A page in the record carries the note
// "Approved by Dana Whitfield (compliance). Note: no baseline diff was
// available; body is identical to published v1" on a version that changed four
// lines — free text an approver typed, in good faith, because the approve pane
// had told them there was no baseline (that half is fixed; this note is not,
// and must not be).
//
// The decision was to leave it. Canon's whole claim is that the record is what
// people actually wrote, with its history; a product that silently corrects a
// human's sentence teaches exactly the wrong thing about itself, and it would
// be indistinguishable, later, from a product that silently corrects anything
// else. So the note stands and the correction is filed ALONGSIDE it, by a
// person, with their name and the date on it — which is the mechanism Canon
// already has for "this is wrong and we are not deleting it".
//
// The half that was missing was not the mechanism, it was the pointer:
// somebody reading a version note is on THIS screen, and the corrections are
// on the page. The sentence below is what joins them, and it carries the count
// so it is not a link into an empty room.
//
// The link is to the page and NOT to `#/pages/<id>#comments`: the hash IS the
// router here, so a fragment on the end of a route is read as part of the page
// id and the link resolves to nothing (the same trap noticeHref documents).
function versionNoteStandingHTML(id, comments) {
  const n = Array.isArray(comments) ? comments.length : null;
  return `
    <p class="muted">A note is what somebody wrote when they published or approved, and it is kept
      exactly as they wrote it — Canon never edits one, even when it turns out to be wrong. A
      correction is added beside it${n === null ? '' : n === 0
        ? ', as a comment on the page. There are none on this page.'
        : `, as a comment on the page — <a href="#/pages/${esc(id)}">there ${n === 1 ? 'is 1' : `are ${n}`}
           on this page</a>.`}</p>`;
}

async function viewHistory(id) {
  const [page, versions, comments] = await Promise.all([
    api('GET', `/pages/${id}`),
    api('GET', `/pages/${id}/versions`),
    // Not fatal: a deployment without comments still has a history, and the
    // sentence simply says less rather than the screen failing over a pointer.
    api('GET', `/pages/${id}/comments`).catch(() => null),
    loadActors().catch(() => null),
  ]);
  const desc = [...versions].reverse();
  app.innerHTML = `
    <div class="page-wide">
      <p class="breadcrumb"><a href="#/pages/${esc(id)}">← ${esc(page.title)}</a></p>
      <div class="page-head">
        <h1>Version history ${badge(page.status)}</h1>
        <button class="btn primary" id="compare-btn" disabled>Compare selected</button>
      </div>
      <p class="muted">Every published version is kept. Restoring never rewrites history —
      it publishes the old content as a new version. Select two versions to compare.</p>
      ${/* The audit log scoped to this page. It is here because this is where
            somebody is already standing when they want it: "what happened to
            THIS page" was previously answerable only by reading the whole log,
            since the page filter was accepted by the API and then ignored. */ ''}
      <p class="muted">Versions are what was published. For everything that happened to this page —
      views of restricted material, submissions, send-backs, approvals —
      <a href="#/audit?page=${encodeURIComponent(id)}">see its audit log</a>.</p>
      ${versionNoteStandingHTML(id, comments)}
      ${/* Six columns, so the table scrolls inside its own container on a narrow
            screen rather than pushing the page sideways — the same treatment
            the collection's contents table has, for the same reason: nothing in
            this product may scroll horizontally. */ ''}
      ${versions.length ? `
        <div class="table-scroll">
        <table class="table">
          <thead><tr><th></th><th>Version</th><th>Published</th><th>Author</th><th>Note</th><th></th></tr></thead>
          <tbody>
            ${desc.map((v) => `
              <tr>
                <td><input type="checkbox" data-cmp="${v.number}" aria-label="Select version ${v.number} for compare"></td>
                <td>v${v.number} ${v.number === page.currentVersion ? '<span class="role-tag">current</span>' : ''}</td>
                <td>${fmtDateTime(v.createdAt)}</td>
                <td>${actorLabel(v.authorId)}</td>
                <td class="muted">${esc(v.note ?? '')}</td>
                <td class="t-right">
                  <a class="btn subtle" href="#/pages/${esc(id)}/versions/${v.number}">View</a>
                  ${v.number !== page.currentVersion && page.status !== 'archived'
                    ? `<button class="btn subtle" data-restore="${v.number}">Restore</button>` : ''}
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
        </div>` : `
        <div class="empty-state">
          <h2>No published versions yet</h2>
          <p>History begins with the first publish.</p>
        </div>`}
    </div>`;

  const compareBtn = app.querySelector('#compare-btn');
  const boxes = [...app.querySelectorAll('[data-cmp]')];
  const refresh = () => {
    const picked = boxes.filter((b) => b.checked);
    compareBtn.disabled = picked.length !== 2;
  };
  boxes.forEach((b) => b.addEventListener('change', () => {
    const picked = boxes.filter((x) => x.checked);
    if (picked.length > 2) { b.checked = false; }
    refresh();
  }));
  compareBtn.addEventListener('click', () => {
    const picked = boxes.filter((b) => b.checked).map((b) => Number(b.dataset.cmp)).sort((a, b) => a - b);
    if (picked.length === 2) location.hash = `#/pages/${id}/compare/${picked[0]}/${picked[1]}`;
  });

  app.querySelectorAll('[data-restore]').forEach((btn) => {
    btn.addEventListener('click', () => openModal({
      title: `Restore version ${btn.dataset.restore}`,
      submitLabel: 'Restore',
      body: `<p>The content of version ${esc(btn.dataset.restore)} will be published as a new
        version. Nothing in history changes. Continue?</p>`,
      onSubmit: async () => {
        const p = await api('POST', `/pages/${id}/restore`, { version: Number(btn.dataset.restore) });
        toast(`Restored as v${p.currentVersion}.`, 'ok');
        route();
      },
    }));
  });
}

// ---------------------------------------------------------------------------
// Single-version view

// What standing does the version on the screen hold?
//
// This heading used to badge `page.status` whatever version was open, which
// made it a statement about today printed beside text from years ago: v1 of a
// page long since approved read CANONICAL, and every superseded version of a
// page the freshness sweep had flipped read NEEDS UPDATE — as though the old
// text were the thing that had gone stale.
//
// Status is a column on `pages`, not a field on a version (see model.ts), so a
// superseded version has no status of its own to show. It could be derived —
// attestation.ts reconstructs the status history from the audit log — but the
// answer is a range, not a value: a version can be approved, sit Canonical for
// a year, go past review, and be replaced, and no single badge is true of all
// of that. So a superseded version gets no status badge at all. It is marked
// superseded, which is the one thing the record does say about it, and the
// notice above already links the version that is current. Point-in-time
// standing has a place that answers it properly, with the approval and the
// dates attached: the attestation.
function versionStanding(page, isCurrent) {
  if (isCurrent) return badge(page.status);
  return '<span class="role-tag">superseded</span>';
}

async function viewVersion(id, n) {
  const [page, version] = await Promise.all([
    api('GET', `/pages/${id}`),
    api('GET', `/pages/${id}/versions/${n}`),
    loadActors().catch(() => null),
  ]);
  const isCurrent = page.currentVersion === n;
  app.innerHTML = `
    <div class="page-wide">
      <p class="breadcrumb"><a href="#/pages/${esc(id)}/history">← Version history</a></p>
      <div class="notice ${isCurrent ? '' : 'notice-version'}">
        Viewing <strong>v${n}</strong> of <strong>${esc(page.title)}</strong>,
        published ${fmtDateTime(version.createdAt)} by ${actorLabel(version.authorId)}.
        ${isCurrent ? 'This is the current version.' : `The current version is v${page.currentVersion ?? '—'}.
          ${page.status !== 'archived' ? `<button class="btn subtle" id="restore-here">Restore this version</button>` : ''}`}
      </div>
      <h1 class="doc-title">${esc(version.title)} ${versionStanding(page, isCurrent)}</h1>
      <dl class="field-block">
        <div><dt>Type</dt><dd>${esc(TYPE_LABELS[page.type] ?? page.type)}</dd></div>
        ${version.fields.ownerId ? `<div><dt>Owner</dt><dd>${actorLabel(version.fields.ownerId)}</dd></div>` : ''}
        ${version.fields.approverId ? `<div><dt>Approver</dt><dd>${actorLabel(version.fields.approverId)}</dd></div>` : ''}
        ${version.fields.effectiveDate ? `<div><dt>Effective date</dt><dd>${fmtDate(version.fields.effectiveDate)}${
          version.fields.effectiveDateBasis
            ? `<div class="field-basis"><span class="muted">Stated basis:</span> ${esc(version.fields.effectiveDateBasis)}</div>`
            : ''
        }</dd></div>` : ''}
        ${version.fields.reviewDate ? `<div><dt>Review date</dt><dd>${fmtDate(version.fields.reviewDate)}</dd></div>` : ''}
        ${version.note ? `<div><dt>Version note</dt><dd>${esc(version.note)}</dd></div>` : ''}
      </dl>
      <article class="doc-body">${withWithheldLinks(version.withheldLinks, () => renderMarkdown(version.body))}</article>
    </div>`;
  app.querySelector('#restore-here')?.addEventListener('click', () => openModal({
    title: `Restore version ${n}`,
    submitLabel: 'Restore',
    body: `<p>The content of version ${n} will be published as a new version. Nothing in
      history changes. Continue?</p>`,
    onSubmit: async () => {
      const p = await api('POST', `/pages/${id}/restore`, { version: n });
      toast(`Restored as v${p.currentVersion}.`, 'ok');
      location.hash = `#/pages/${id}`;
    },
  }));
}

// ---------------------------------------------------------------------------
// Side-by-side compare

async function viewCompare(id, a, b) {
  const [page, va, vb] = await Promise.all([
    api('GET', `/pages/${id}`),
    api('GET', `/pages/${id}/versions/${a}`),
    api('GET', `/pages/${id}/versions/${b}`),
    loadActors().catch(() => null),
  ]);
  const rows = diffLines(va.body, vb.body);
  const changed = changedLines(rows);
  // Fields are part of a version, so a compare that reads only the bodies is
  // comparing part of each version and reporting on the whole: "identical
  // bodies" over an alias-only change told an approver there was no change at
  // all (third round, finding 1). Same rows, same rendering as the review
  // panel — a field change must read the same on the screen that decides and
  // the screen that checks.
  const fieldRows = changedFieldRows(va.fields ?? {}, vb.fields ?? {}, true);
  const extent = changed
    ? `${changed} changed line${changed === 1 ? '' : 's'}${
        fieldRows.length ? `, and ${fieldRows.length} changed field${fieldRows.length === 1 ? '' : 's'}` : ''
      }.`
    : fieldRows.length
      ? `The bodies are identical; ${fieldRows.length} field${fieldRows.length === 1 ? '' : 's'} changed.`
      : 'The two versions are identical in body and fields.';
  app.innerHTML = `
    <div class="page-wide">
      <p class="breadcrumb"><a href="#/pages/${esc(id)}/history">← Version history</a></p>
      <div class="page-head">
        <h1>Compare <span class="muted">${esc(page.title)}</span></h1>
      </div>
      ${va.title !== vb.title ? `<p class="notice">Title changed:
        <del>${esc(va.title)}</del> → <ins>${esc(vb.title)}</ins></p>` : ''}
      <p class="muted">${extent}</p>
      ${fieldRowsHTML(fieldRows)}
      ${diffTableHTML(
        rows,
        `v${a} · ${fmtDateTime(va.createdAt)} · ${actorLabel(va.authorId)}`,
        `v${b} · ${fmtDateTime(vb.createdAt)} · ${actorLabel(vb.authorId)}`,
      )}
    </div>`;
}

// ---------------------------------------------------------------------------
// Audit view

// USER-TESTING.md T2.2, and the shape of the whole view follows from it. An
// auditor found this screen showing 200 rows of 1,187 with no count, no
// paging, no date filter, no export, and an action list hard-coded here that
// was missing ten of the actions the record writes. Her conclusion was that no
// sample drawn from it was defensible — not because the rows were wrong, but
// because nothing on the screen said what the rows were a sample OF.
//
// So three things are load-bearing here and should not be quietly dropped:
// the population count beside the page count, the walk that can actually reach
// the end of the log, and the export carrying the filter rather than the page.
// THE DETAIL COLUMN, IN WORDS (USER-TESTING.md T4.9).
//
// It used to print the event's details object more or less as JSON:
// `assertedToPageId: 3f9c…`, `collectionIds: ["4e19…","a212…"]`,
// `generator: extractive-v1`. Every one of those is true and none of it is
// legible, and a log an auditor cannot read at a glance is a log they sample
// badly. Three changes, all of them client-side and none of them inventing
// anything the server did not send:
//
//   the KEY is said in words;
//   an id whose kind is known is drawn as the thing it names — an actor by
//     name, a collection by name, a page by its title where some row on the
//     same screen carried it, and by a shortened, linked id where none did;
//   an object is spelled out rather than stringified.
//
// A name Canon does not hold stays an id. It is shortened and linked, never
// guessed at, because a wrong name in an audit log is worse than a long one.
const AUDIT_DETAIL_LABELS = {
  actorId: 'Actor', authorId: 'Author', approverId: 'Approver', assertedBy: 'Asserted by',
  editorId: 'Editor', memberId: 'Member', ownerId: 'Owner', submittedById: 'Submitted by',
  pageId: 'Page', fromPageId: 'From page', toPageId: 'To page',
  assertedFromPageId: 'Asserted from', assertedToPageId: 'Asserted to', citedPageIds: 'Pages cited',
  collectionId: 'Collection', collectionIds: 'Collections', toCollectionId: 'To collection',
  parentId: 'Parent page', referenceId: 'Reference', relationId: 'Relation',
  sourceId: 'Source', sourceName: 'Source', runId: 'Import run',
  // The one that reads as machinery even when it is spelled out, so it is
  // spelled out AND said: which generator wrote the answer.
  generator: 'Answered by', from: 'From', to: 'To', via: 'Granted', reason: 'Because',
  freshnessWindowMs: 'Freshness window', sweptOn: 'Swept on', orgRole: 'Organisation role',
  // The answer events' page lists. These printed as bare shortened ids — a
  // DPO called that a page id where a title would do (fourth round) — and
  // they ARE pages, so they belong in AUDIT_PAGE_KEYS below, where a title
  // some row on the same screen carries can name them.
  nearestPageIds: 'Nearest pages', disagreement: 'Disagreeing pages',
  supersession: 'Supersession between', disagreementAsserted: 'Disagreement asserted by',
};

const AUDIT_ACTOR_KEYS = new Set([
  'actorId', 'authorId', 'approverId', 'assertedBy', 'editorId', 'memberId', 'ownerId', 'submittedById',
  'disagreementAsserted',
]);
const AUDIT_PAGE_KEYS = new Set([
  'pageId', 'parentId', 'fromPageId', 'toPageId', 'assertedFromPageId', 'assertedToPageId', 'citedPageIds',
  'nearestPageIds', 'disagreement', 'supersession',
]);
const AUDIT_COLLECTION_KEYS = new Set(['collectionId', 'collectionIds', 'toCollectionId']);

// Keys that say the same thing as another key on the same event, and are
// dropped when they do.
//
// `sourceId` beside `sourceName` printed "Source: 2083de98… Source: People
// System", which reads as two different sources. And a relation carries both
// the pair as STORED and the pair as ASSERTED — the stored order can be
// swapped for a symmetric relation, which is a real distinction and is worth
// exactly the row space it takes when the two differ, and none when they do
// not. So the asserted pair appears only where it says something the stored
// pair does not.
const AUDIT_REDUNDANT_WHEN = {
  sourceId: 'sourceName',
  assertedFromPageId: 'fromPageId',
  assertedToPageId: 'toPageId',
};

/** Is `key` saying what a sibling key already said on this event? */
function auditKeyIsRedundant(key, fields) {
  const sibling = AUDIT_REDUNDANT_WHEN[key];
  if (!sibling || fields[sibling] == null) return false;
  // A name beside an id: the name wins. A pair beside the same pair: drop one.
  return key === 'sourceId' || fields[sibling] === fields[key];
}

function auditDetailLabel(key) {
  return AUDIT_DETAIL_LABELS[key] ?? humanizeKey(key);
}

/** A bare identifier — a UUID or something shaped like one. */
function looksLikeId(text) {
  return /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(text);
}

/** An id, shortened but still an id, and linked to what it names. */
function auditIdLinkHTML(id, href) {
  const short = id.length > 12 ? `${id.slice(0, 8)}…` : id;
  return `<a href="${esc(href)}" title="${esc(id)}"><code class="action-code">${esc(short)}</code></a>`;
}

function auditDetailValueHTML(key, value, pageTitles, collectionNames) {
  if (value === null || value === undefined) return '<span class="muted">—</span>';
  if (Array.isArray(value)) {
    if (!value.length) return '<span class="muted">none</span>';
    return value.map((v) => auditDetailValueHTML(key, v, pageTitles, collectionNames)).join(', ');
  }
  if (typeof value === 'object') {
    // `counts: {found:7, imported:6, failed:1}` reads as an import summary
    // rather than as a blob.
    return esc(Object.entries(value).map(([k, v]) => `${humanizeKey(k).toLowerCase()} ${v}`).join(', '));
  }
  const text = String(value);
  if (AUDIT_ACTOR_KEYS.has(key)) return esc(actorName(text));
  if (AUDIT_PAGE_KEYS.has(key)) {
    const title = pageTitles.get(text);
    return title
      ? `<a href="#/pages/${esc(text)}">${esc(title)}</a>`
      : auditIdLinkHTML(text, `#/pages/${encodeURIComponent(text)}`);
  }
  if (AUDIT_COLLECTION_KEYS.has(key)) {
    const name = collectionNames.get(text);
    return name
      ? `<a href="#/collections/${esc(text)}">${esc(name)}</a>`
      : auditIdLinkHTML(text, `#/collections/${encodeURIComponent(text)}`);
  }
  if (key === 'freshnessWindowMs') return esc(fmtDuration(Number(text)));
  // A relation id, a reference id, an import run id: nothing this client can
  // name and nothing it can link to, so it is shown as what it is — an
  // identifier — short enough to scan past, with the whole of it on hover and
  // selectable in the CSV export, which is where an auditor would use it.
  if (looksLikeId(text)) return `<code class="action-code" title="${esc(text)}">${esc(text.slice(0, 8))}…</code>`;
  return esc(text);
}

// The refused-questions view: what people asked and the record could not
// answer, for the people who close the loop — an operator over the whole
// record, and a collection's administrator over their own, which is where the
// remedy actually lives: "the gaps list and the fix live with different
// people" (round seven). Each row is a decision —
// teach the record a word (the nearest page's "Also known as" field), write
// the missing page, or record that the record owes no answer. No asker is
// shown here and none is stored in this list; the audit log can join a gap
// to its asker, deliberately, under its own rule — the screen says exactly
// that, because the earlier wording claimed an anonymity the product does
// not have (third round, finding 3).
async function viewGaps(query = {}) {
  const status = query.status ?? 'open';
  let answer;
  try {
    answer = await api('GET', `/gaps?status=${encodeURIComponent(status)}`);
  } catch (err) {
    renderErrorPage(err);
    return;
  }
  const gaps = answer.gaps ?? [];
  // WHOSE LIST THIS IS, from the server rather than guessed. An operator holds
  // the whole record's refusals; a collection's administrator holds the ones
  // asked of their own collections, and a page that described the second as
  // the first would be making the claim Phase 5 removed from four screens.
  const steward = answer.scope === 'steward';
  const covers = answer.collections ?? [];
  const tabs = ['open', 'resolved', 'dismissed']
    .map((t) => `<a class="btn ${t === status ? 'primary' : ''}" href="#/gaps${t === 'open' ? '' : `?status=${t}`}">${t[0].toUpperCase()}${t.slice(1)}</a>`)
    .join(' ');
  const rows = gaps.map((g) => `
    <article class="gap-card" data-gap="${esc(g.id)}">
      <div class="gap-head">
        <p class="gap-question">&ldquo;${esc(g.question)}&rdquo;</p>
        <p class="muted">Asked ${g.timesAsked === 1 ? 'once' : `${g.timesAsked} times`} · last ${fmtDateTime(g.lastAskedAt)}</p>
      </div>
      ${g.nowAnswers === true ? `<p class="gap-nowanswers">The record now answers this — re-check before resolving.</p>` : ''}
      ${g.nearest.length ? `<p class="muted">Came closest: ${g.nearest.map((n) => `<a href="#/pages/${esc(n.pageId)}">${esc(n.title)}</a>`).join(' · ')}</p>` : ''}
      ${g.status === 'open' ? `
        <div class="gap-actions">
          ${/* One note, both closures. It used to be required only for
                resolving, which made a dismissal the one closure with no
                reason on it — unauditable forever (fourth round, Dana). The
                server refuses an empty note either way now; the placeholder
                offers both sentences so neither button reads as the one
                without homework. */ ''}
          <input type="text" class="gap-note" value="${g.nowAnswers === true ? 'Re-asked: the record answers this now.' : ''}"
            placeholder="What was done, or why the record owes no answer — required either way">
          <button class="btn primary" data-close="resolved">Resolved</button>
          <button class="btn subtle" data-close="dismissed">Not the record’s business</button>
        </div>
        ${/* Tomas's laundering path: a question can carry exactly what the
              gaps view exists to keep out of public vocabulary ("grievance
              about my manager", a client name). The guard is copy, and it
              stands where the operator acts, not in a manual. */ ''}
        <p class="muted type-help gap-guard">Add the asker&rsquo;s <em>words for the subject</em> as an alias —
          never paste their question verbatim into a page.</p>` : `
        <p class="muted">${g.status === 'resolved' ? 'Resolved' : 'Dismissed'}${g.resolution ? `: ${esc(g.resolution)}` : ''}</p>`}
    </article>`).join('');

  app.innerHTML = `
    <div class="page-wide">
      <div class="page-head"><h1>Gaps</h1><div class="actions">${tabs}</div></div>
      <p class="muted">Questions the record refused. Each one is a decision: teach a page the
        asker&rsquo;s word (its &ldquo;Also known as&rdquo; field), write the missing page, or record that this
        record owes no answer. No asker is shown here, and none is stored in this list; operators can
        read who asked what in the audit log, which has its own rule.</p>
      ${steward ? `
        <p class="muted gap-scope">You are reading the gaps asked of ${covers.length
          ? covers.map((c) => `<a href="#/collections/${esc(c.id)}">${esc(c.name)}</a>`).join(', ')
          : 'the collections you administer'} — the collections you administer. Questions asked across the
          whole record, and questions asked of collections you do not administer, are not in this list.</p>`
        : ''}
      ${/* One sentence used to serve all three tabs: "No <status> gaps. Every
            question the record refused has been looked at." True on the OPEN
            tab and false on the other two — an empty Resolved tab means
            nothing has been resolved, and the sentence claimed the opposite of
            what it was describing. The tabs are three different filters over
            one list, and only one of them can say anything about the whole of
            it (round seven, Phase 5). */ ''}
      ${gaps.length ? rows : `<div class="empty-state"><p>${status === 'open'
        ? (steward
          ? 'No open gaps in the collections you administer. This says nothing about the rest of the record.'
          : 'No open gaps. Every question the record refused has been looked at.')
        : status === 'resolved'
          ? 'No gap has been resolved yet. Open gaps, if there are any, are on the Open tab.'
          : 'No gap has been dismissed. Open gaps, if there are any, are on the Open tab.'}</p></div>`}
    </div>`;

  app.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const card = btn.closest('[data-gap]');
      const noteField = card.querySelector('.gap-note');
      const note = noteField.value.trim();
      // The server refuses an empty note for either outcome; saying so here
      // saves the round trip and puts the cursor where the sentence goes.
      if (!note) {
        toast(btn.dataset.close === 'resolved'
          ? 'Resolving a gap records what was done; say it in a sentence.'
          : 'Dismissing a gap records why the record owes no answer; say it in a sentence.');
        noteField.focus();
        return;
      }
      try {
        await api('POST', `/gaps/${card.dataset.gap}/close`, { outcome: btn.dataset.close, note });
        toast(btn.dataset.close === 'resolved' ? 'Gap resolved.' : 'Gap dismissed.', 'ok');
        await viewGaps(query);
      } catch (err) { toastError(err); }
    });
  });
}

/**
 * The one sentence under the audit filters, from BOTH of the numbers it is
 * describing at once.
 *
 * The log draws from two routes — `/audit` for the rows and `/audit/summary`
 * for the size of the population — and the screen used to let them speak
 * separately. The count line was written only where rows existed, so narrowing
 * a filter to nothing left the previous filter's sentence standing over a
 * fresh "No matching events" panel: "168 events match these filters" and "No
 * matching events", on screen together, both about different filters, one of
 * them a lie (round seven, Phase 5). An auditor deciding a population is empty
 * is exactly the reader who must not be shown a stale number.
 *
 * So the sentence is computed from the pair, always, including when there are
 * no rows — and the disagreement case is stated rather than resolved in
 * either direction. Two answers from two queries that cannot both be true is
 * not something a screen may quietly pick a winner for; the honest move is to
 * say the walk is unreliable and let the reader reload, because the wrong
 * guess here ("show the count", "show the emptiness") produces a confident
 * false claim in a compliance artefact.
 */
function auditCountLine(shownCount, matching) {
  const n = Number(matching);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n === 0) return 'No events in the log match these filters.';
  if (shownCount === 0) {
    return `These filters match ${n.toLocaleString()} event${n === 1 ? '' : 's'}, but none of them came back ` +
      'with this page of the log. Reload before treating this as an empty result.';
  }
  // Every count on this screen is PERMISSION-FILTERED to the reader — the same
  // property the attestation bundle spells out (attestation.ts BUNDLE_LIMITS).
  // "you can see" keeps the number from being read as the record's own total: a
  // non-admin's 1,098 is the events THEY may see, and the log holds more. The
  // hidden count is never named.
  return shownCount >= n
    ? `${n.toLocaleString()} event${n === 1 ? '' : 's'} you can see match${n === 1 ? 'es' : ''} these filters. All of them are shown.`
    : `Showing the ${shownCount.toLocaleString()} most recent of ${n.toLocaleString()} matching events you can see.`;
}

/** The heading over an empty table, which may only claim absence when the
 *  count agrees that the population is empty. */
function auditEmptyHeading(matching) {
  return Number(matching) > 0 ? 'These events did not load' : 'No matching events';
}

/**
 * What `GET /audit/verify` came back with, said to a person.
 *
 * TWO RULES, both taken from the response itself rather than invented here.
 *
 * A CLEAN RESULT IS NOT A CLAIM OF AUTHENTICITY. `auditchain.ts` is explicit
 * that a competently forged log — an event deleted and every later link
 * recomputed — answers this check `ok: true`, and that this was actually done
 * to a Canon record during review. So the verdict line never stands alone: the
 * response's own `proves` and `limits` sentences travel with it, and they are
 * printed as the server wrote them rather than paraphrased, because a
 * paraphrase in a client is exactly where a caveat goes quietly missing.
 *
 * A PARTIAL WALK SAYS NOTHING ABOUT THE REST. `partial` means a limit stopped
 * the walk, and "no break in what was walked" is a weaker sentence than "no
 * break". They are drawn as two different verdicts.
 */
function chainVerdictHTML(r) {
  const n = (v) => Number(v ?? 0).toLocaleString();
  const unchained = Number(r.unchained ?? 0);
  const before = unchained
    ? ` ${n(unchained)} event${unchained === 1 ? '' : 's'} ${unchained === 1 ? 'was' : 'were'} written before the
        chain existed, so the chain has never covered ${unchained === 1 ? 'it' : 'them'} and never will.`
    : '';
  const head = r.head
    ? `<p class="muted chain-head">The chain's head is event ${n(r.head.eventId)}. Compare it against a copy kept
        outside Canon — that comparison, and nothing on this screen, is what turns this into a statement about
        whether the log is genuine.</p>`
    : '';
  const verdict = r.ok
    ? r.partial
      ? `<p class="chain-verdict chain-partial"><strong>No break in the part that was walked.</strong>
          The walk stopped before the end of the log, so this says nothing about the events beyond it.</p>`
      : `<p class="chain-verdict chain-ok"><strong>The chain joins up.</strong> ${n(r.verified)} of
          ${n(r.events)} event${Number(r.events) === 1 ? '' : 's'} were re-hashed and every link still
          matches.${before}</p>`
    : `<p class="chain-verdict chain-broken"><strong>The chain is broken.</strong>
        ${r.firstBreak ? `First at event ${n(r.firstBreak.eventId)}${
            r.firstBreak.at ? ` (${esc(fmtDateTime(r.firstBreak.at))})` : ''
          }${r.firstBreak.action ? `, <code class="action-code">${esc(r.firstBreak.action)}</code>` : ''}.
          ${esc(r.firstBreak.explanation ?? '')}` : ''}
        Only the first break is reported: after one, every later link is computed against a hash that is
        already wrong.</p>`;
  return `
    <section class="panel chain-check">
      ${verdict}
      ${r.proves ? `<p class="muted">What a clean walk proves: ${esc(r.proves)}</p>` : ''}
      ${r.limits ? `<p class="muted"><strong>What it does not:</strong> ${esc(r.limits)}</p>` : ''}
      ${head}
      ${r.externalAnchor ? `<details class="chain-anchor"><summary>Keeping the head where Canon cannot rewrite it</summary>
        <p class="muted">${esc(r.externalAnchor)}</p></details>` : ''}
      <p class="muted chain-when">Checked ${esc(fmtDateTime(r.checkedAt))}.</p>
    </section>`;
}

async function viewAudit(query = {}) {
  await loadActors().catch(() => null);
  let collections = [];
  try { collections = await api('GET', '/collections'); } catch { collections = []; }

  // Filters live in the URL, so a scoped log is a link an auditor can put in a
  // working paper and come back to — and so "the history of this page" can be
  // a link from the page itself rather than a filter nobody can find.
  const filters = {
    action: query.action ?? '',
    actor: query.actor ?? '',
    collection: query.collection ?? '',
    page: query.page ?? '',
    from: query.from ?? '',
    to: query.to ?? '',
  };

  app.innerHTML = `
    <div class="page-wide">
      <div class="page-head">
        <h1>Audit log</h1>
        ${/* A button, not an anchor. A bare link to the CSV route is a
              navigation the app never sees, so it carries no X-Actor-Id —
              under header auth the export failed for exactly the person it
              exists for (third round, Ruth). The click goes through
              downloadFromApi, which attaches identity the way api() does in
              both auth modes. */ ''}
        ${/* Disabled until the summary lands. The export carries the FILTERS,
              not the rows on screen, so before the first load nobody — not the
              auditor, not this screen — knows how many events the click is
              about; an export whose size is unknown is the shape of finding a
              sample in a working paper labelled as a population. It enables
              the moment the count that describes it exists. */ ''}
        <div class="actions"><button class="btn" id="audit-export" type="button" disabled
          title="Enables when the log has loaded.">Export CSV</button></div>
      </div>
      ${/* THE ONE CLAIM CANON MAKES WITHOUT SHOWING ITS EVIDENCE.
            Round seven, tester 13, who credited the product for volunteering
            the attack that defeats its own chain and for shipping twelve
            numbered self-disclosed limits: "the single place it asserts
            without evidence is the word 'Append-only.' at the top of the audit
            page."

            The evidence was already built and already refused to overclaim —
            `GET /audit/verify` walks the chain, names the first break, and
            carries `proves` and `limits` in the same object as its verdict. It
            had one caller in this client and it was a FEATURE PROBE:
            `?limit=1`, one link, thrown away, used only to decide whether to
            draw the Attestation button. So the check ran on this screen and
            nobody was ever shown what it said. */ ''}
      <p class="muted">Append-only. Every write, workflow step, and view of restricted
      material, attributed to its actor. The counts and totals on this screen — the
      action list, and the number of matching events — cover only what you can see;
      the record may hold more that your role does not, and these numbers are not a
      claim that nothing else exists.
      <button class="btn subtle" id="audit-verify" type="button">Check the chain</button></p>
      <div id="audit-verdict" aria-live="polite"></div>
      <form id="audit-filters" class="inline-form">
        <label>Action <select name="action"><option value="">All actions</option></select></label>
        <label>Actor
          <select name="actor">
            <option value="">All actors</option>
            ${(state.actors ?? []).map((a) => `<option value="${esc(a.id)}"${a.id === filters.actor ? ' selected' : ''}>${esc(a.name)}${a.kind === 'agent' ? ' (agent)' : ''}</option>`).join('')}
            <!-- Canon's own actor is not in the directory (it is nobody you can
                 name as an owner), but it IS in the log, and an auditor sampling
                 the log has to be able to isolate the machine's acts from the
                 people's. So it is offered here and only here. -->
            <option value="${esc(SYSTEM_ACTOR_ID)}"${filters.actor === SYSTEM_ACTOR_ID ? ' selected' : ''}>${esc(SYSTEM_ACTOR_NAME)} (system)</option>
          </select>
        </label>
        <label>Collection
          <select name="collection">
            <option value="">All collections</option>
            ${collections.map((c) => `<option value="${esc(c.id)}"${c.id === filters.collection ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}
          </select>
        </label>
        <label>From <input type="date" name="from" value="${esc(filters.from)}"></label>
        <label>To <input type="date" name="to" value="${esc(filters.to)}"></label>
        ${filters.page ? `<span class="chip">One page <a href="#" id="audit-clear-page" title="Show the whole log again">clear</a></span>` : ''}
      </form>
      <p id="audit-count" class="muted"></p>
      <div id="audit-table"><div class="loading">Loading…</div></div>
      <div id="audit-more"></div>
    </div>`;

  const form = app.querySelector('#audit-filters');
  const tableHost = app.querySelector('#audit-table');
  const countHost = app.querySelector('#audit-count');
  const moreHost = app.querySelector('#audit-more');

  // The evidence behind "Append-only." A full walk, not the probe's single
  // link: the probe answers "does this endpoint exist", and the reader is
  // asking a different question. The refusal is drawn IN PLACE rather than
  // toasted, because the sentence names who can check and that is worth
  // reading twice, not for three seconds in a corner.
  const verifyBtn = app.querySelector('#audit-verify');
  const verdictHost = app.querySelector('#audit-verdict');
  verifyBtn?.addEventListener('click', async () => {
    verifyBtn.disabled = true;
    verdictHost.innerHTML = '<div class="loading">Walking the chain…</div>';
    try {
      verdictHost.innerHTML = chainVerdictHTML(await api('GET', '/audit/verify'));
    } catch (err) {
      verdictHost.innerHTML = `<div class="panel chain-check"><p class="chain-verdict chain-refused">${
        esc(err?.message ?? 'The chain could not be checked.')}</p></div>`;
    } finally {
      verifyBtn.disabled = false;
    }
  });

  const current = () => ({
    action: form.action.value,
    actor: form.actor.value,
    collection: form.collection.value,
    page: filters.page,
    from: form.from.value,
    to: form.to.value,
  });

  const paramsOf = (f) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
    return p;
  };

  // Everything shown so far, across every "Show older" the reader has pressed.
  // Kept here rather than re-fetched, because re-fetching page one to append
  // page two is how a walk starts disagreeing with itself.
  let shown = [];

  // Names for the ids the log's detail column is full of. Actors and
  // collections this client already knows; page titles come off the rows
  // themselves — an event carries the title of the page it is ABOUT, and the
  // page a relation points at is very often the subject of another row on the
  // same screen. Nothing here fetches, and nothing invents a name it was not
  // given: an id with no title stays an id, shortened and linked.
  const collectionNames = new Map(collections.map((c) => [c.id, c.name]));
  const pageTitles = new Map();

  const rowHtml = (e) => {
    const fields = e.details ?? {};
    const details = Object.entries(fields)
      .filter(([k]) => !auditKeyIsRedundant(k, fields))
      .map(([k, v]) => `<span class="detail-kv"><span class="muted">${esc(auditDetailLabel(k))}:</span> ` +
        `${auditDetailValueHTML(k, v, pageTitles, collectionNames)}</span>`)
      .join(' ');
    // "Where" read the word "page" for every page event, which told an auditor
    // scanning a thousand rows nothing at all. It names the thing now, and the
    // link scopes the log to it rather than leaving the log.
    // The server joins the page's title and the collection's name onto the
    // event; it is the name NOW, not at the instant (see queryAudit). A row
    // whose page has since been deleted falls back to the bare word rather
    // than inventing one.
    const where = e.pageId
      ? `<a href="#/pages/${esc(e.pageId)}">${esc(e.pageTitle ?? 'page')}</a>`
      : e.collectionId
        ? `<a href="#/collections/${esc(e.collectionId)}">${esc(e.collectionName ?? 'collection')}</a>`
        : '<span class="muted">—</span>';
    return `<tr>
      <td class="nowrap">${fmtInstant(e.at)}</td>
      <td>${esc(actorName(e.actorId))} ${e.actorKind === 'person' ? '' : kindTag(e.actorKind)}</td>
      <td><code class="action-code">${esc(e.action)}</code></td>
      <td>${where}</td>
      <td class="audit-details">${details || '<span class="muted">—</span>'}</td>
    </tr>`;
  };

  const render = (matching) => {
    // Learn every page title on screen before any row is drawn, so a detail
    // that names another row's page can name it rather than print its id.
    for (const e of shown) if (e.pageId && e.pageTitle) pageTitles.set(e.pageId, e.pageTitle);
    // The count line is written FIRST and unconditionally, because the branch
    // that used to skip it is the branch where a stale one does the damage.
    countHost.textContent = auditCountLine(shown.length, matching);
    if (!shown.length) {
      tableHost.innerHTML = `
        <div class="empty-state"><h2>${esc(auditEmptyHeading(matching))}</h2>
        <p>${matching > 0
          ? 'The count above and this listing disagree. Reload the log rather than reporting an empty result.'
          : 'Nothing in the log matches these filters.'}</p></div>`;
      moreHost.innerHTML = '';
      return;
    }
    // Five columns, one of them free-form detail JSON, so the table has a real
    // minimum width and a narrow viewport must scroll IT rather than the page.
    // Same container the Sources table uses; a body that scrolls sideways
    // takes the filters and the count off screen with it.
    tableHost.innerHTML = `
      <div class="table-scroll">
        <table class="table audit">
          <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Where</th><th>Details</th></tr></thead>
          <tbody>${shown.map(rowHtml).join('')}</tbody>
        </table>
      </div>`;
    // The sentence that was missing. A screen showing a page and saying
    // nothing about the rest asserts a completeness it does not have.
    const all = shown.length >= matching;
    moreHost.innerHTML = all
      ? ''
      : `<button class="btn" id="audit-older">Show older (${(matching - shown.length).toLocaleString()} more)</button>`;
    const older = moreHost.querySelector('#audit-older');
    if (older) older.addEventListener('click', () => load({ append: true }));
  };

  const exportBtn = app.querySelector('#audit-export');
  /** Neither the count nor the export may outlive the filters they describe. */
  const clearPopulation = (why) => {
    countHost.textContent = '';
    exportBtn.disabled = true;
    exportBtn.title = why;
  };

  const load = async ({ append = false } = {}) => {
    const f = current();
    if (!append) {
      shown = [];
      tableHost.innerHTML = '<div class="loading">Loading…</div>';
      moreHost.innerHTML = '';
      // The previous filters' count described a different population. Holding
      // it over the new one is how "168 events match" ended up above "No
      // matching events" — it was true a request ago.
      clearPopulation('Enables when the log has loaded.');
      // The link an auditor can keep. Replaced rather than pushed, so paging
      // does not fill the back button with filter states.
      const q = paramsOf(f).toString();
      history.replaceState(null, '', `#/audit${q ? `?${q}` : ''}`);
    }
    const params = paramsOf(f);
    // The cursor is the id of the oldest row already shown; see queryAudit.
    if (append && shown.length) params.set('before', String(shown[shown.length - 1].id));
    try {
      const [events, summary] = await Promise.all([
        api('GET', `/audit${params.toString() ? `?${params}` : ''}`),
        api('GET', `/audit/summary${paramsOf(f).toString() ? `?${paramsOf(f)}` : ''}`),
      ]);
      shown = append ? shown.concat(events) : events;
      fillActions(summary.actions, f.action);
      render(summary.matching);
      exportBtn.disabled = false;
      exportBtn.title = `Downloads all ${summary.matching.toLocaleString()} matching events, not just the ones shown.`;
    } catch (err) {
      tableHost.innerHTML = `<div class="empty-state"><h2>Could not load the log</h2><p>${esc(err.message)}</p></div>`;
      // A failed load knows nothing about the population, so it may neither
      // describe it nor offer to download it.
      clearPopulation('The log did not load, so the size of this export is unknown.');
    }
  };

  // The action list comes from the record, with counts. It used to be a
  // hard-coded array here that had drifted: ten action types the record writes
  // were absent from it, and four it offered have never been written.
  const fillActions = (actions, selected) => {
    // The total is the sum of the per-action counts the server returned, which
    // are PERMISSION-FILTERED to this reader — so "you can see" travels with it,
    // for the same reason the count line and the header carry it: the number is
    // this reader's, not the record's.
    const total = actions.reduce((n, a) => n + a.count, 0);
    form.action.innerHTML =
      `<option value="">All actions you can see (${total.toLocaleString()})</option>` +
      actions
        .map((a) => `<option value="${esc(a.action)}"${a.action === selected ? ' selected' : ''}>${esc(a.action)} (${a.count.toLocaleString()})</option>`)
        .join('');
  };

  // The export carries the FILTERS, never the page — so what downloads is
  // the population the count above describes, not the rows on screen.
  app.querySelector('#audit-export').addEventListener('click', async () => {
    const q = paramsOf(current()).toString();
    try {
      const res = await downloadFromApi(`/audit.csv${q ? `?${q}` : ''}`, 'canon-audit.csv');
      // The server marks a file that exactly filled its row cap, because an
      // auditor who assumes they hold the whole log has been handed a sample
      // presented as a population. The mark is a response header, so the one
      // place it can be surfaced is here, at the moment of download.
      if (res.headers.get('x-canon-truncated') === 'true') {
        const cap = Number(res.headers.get('x-canon-row-cap'));
        toast(`The export hit the server's row cap${Number.isFinite(cap) ? ` of ${cap.toLocaleString()} events` : ''} — this file is NOT the whole filtered log. Narrow with From/To and export the windows in turn.`, 'error');
      }
    } catch (err) { toastError(err); }
  });

  for (const name of ['action', 'actor', 'collection', 'from', 'to']) {
    form[name].addEventListener('change', () => load());
  }
  const clearPage = app.querySelector('#audit-clear-page');
  if (clearPage) {
    clearPage.addEventListener('click', (e) => {
      e.preventDefault();
      filters.page = '';
      location.hash = '#/audit';
    });
  }
  await load();
}

// ---------------------------------------------------------------------------
// Sources — registered external systems (DATA-BACKBONE.md §6)
//
//   GET /sources | POST /sources | PUT /sources/:id | DELETE /sources/:id
//   Source: { id, name, kind, baseUrl, authMode: 'per_asker'|'service',
//             freshnessWindowMs, createdAt }
//
// The one screen in Canon where a choice has consequences a reader will live
// with: authMode decides whose permissions resolve a value, and `service`
// means the administrator is publishing that value to the whole collection.
// The two modes are therefore not offered as two equal radio buttons.

const SOURCE_KIND_SUGGESTIONS = ['hris', 'benefits', 'claims', 'crm', 'finance', 'ticketing'];

const FRESHNESS_UNITS = [
  ['minutes', 60000],
  ['hours', 3600000],
  ['days', 86400000],
];

// Split a millisecond window back into the largest unit that divides it
// evenly, so an edit form shows "6 hours" rather than 21600000.
function splitFreshness(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return { value: 15, unit: 60000 };
  for (const [, size] of [...FRESHNESS_UNITS].reverse()) {
    if (n >= size && n % size === 0) return { value: n / size, unit: size };
  }
  return { value: Math.max(1, Math.round(n / 60000)), unit: 60000 };
}

// "Which collections may reference this source" is the other half of the
// administrator's decision. An empty scope is Canon-wide. The field name is
// read tolerantly because the shape has travelled under a few names.
function sourceScopeIds(s) {
  const raw = s?.collectionIds ?? s?.collections ?? s?.scope ?? [];
  if (!Array.isArray(raw)) return [];
  return raw.map((c) => (typeof c === 'string' ? c : c?.id)).filter(Boolean);
}

function sourceScopeCell(s, collections) {
  const ids = sourceScopeIds(s);
  if (!ids.length) {
    return `<span class="kind-tag">Canon-wide</span>
      <span class="muted source-mode-note">Any collection may reference it.</span>`;
  }
  const names = ids.map((id) => collections.find((c) => c.id === id)?.name ?? id);
  return `<span class="muted source-mode-note source-scope-list">${names.map((n) => `<span class="role-tag">${esc(n)}</span>`).join(' ')}</span>`;
}

function authModeCell(mode) {
  if (mode === 'service') {
    return `<span class="kind-tag ref-service">service</span>
      <span class="muted source-mode-note">Published to every collection that references it.</span>`;
  }
  return `<span class="kind-tag">per-asker</span>
    <span class="muted source-mode-note">Resolved as the reader; invisible to anyone the source would refuse.</span>`;
}

function sourceFormBody(source, collections = []) {
  const f = splitFreshness(source?.freshnessWindowMs ?? 900000);
  const isService = source?.authMode === 'service';
  const scope = sourceScopeIds(source);
  return `
    <label>Name <input name="name" required maxlength="120" placeholder="e.g. Benefits Admin"
      value="${esc(source?.name ?? '')}"></label>
    <label>Kind <input name="kind" required maxlength="60" list="source-kind-list"
      placeholder="e.g. benefits" value="${esc(source?.kind ?? '')}"></label>
    <datalist id="source-kind-list">
      ${SOURCE_KIND_SUGGESTIONS.map((k) => `<option value="${esc(k)}"></option>`).join('')}
    </datalist>
    <label>Base URL <input name="baseUrl" required maxlength="400" placeholder="https://…"
      value="${esc(source?.baseUrl ?? '')}"></label>

    <fieldset class="choice-set">
      <legend>Whose permissions resolve this source's values?</legend>
      <label class="choice">
        <input type="radio" name="authMode" value="per_asker" ${isService ? '' : 'checked'}>
        <span class="choice-main">
          <span class="choice-title">The reader's own identity <span class="kind-tag">per-asker</span></span>
          <span class="choice-note">Every value is fetched as the person reading the page. Someone the
            source would refuse sees the refusal here too, stated plainly. Choose this wherever the
            source can accept a caller identity.</span>
        </span>
      </label>
      <label class="choice">
        <input type="radio" name="authMode" value="service" ${isService ? 'checked' : ''}>
        <span class="choice-main">
          <span class="choice-title">A shared service identity <span class="kind-tag ref-service">service</span></span>
          <span class="choice-note">Canon resolves with one account, so the source's own access rules no
            longer apply reader by reader. <strong>Choosing this publishes the value to the collection:
            it becomes visible to everyone who can view any collection this source is referenced
            from.</strong> Values resolved this way are marked as service-resolved on every page that
            shows them.</span>
        </span>
      </label>
    </fieldset>
    <div class="notice notice-locked" data-service-warn ${isService ? '' : 'hidden'}>
      You are choosing to publish this source's values to the collection. Anyone who can view a
      collection that references <strong data-service-name>${esc(source?.name ?? 'this source')}</strong>
      will be able to read them, whatever the source system itself would have allowed them to see.
    </div>

    <div class="field-pair">
      <label>Freshness window <input type="number" name="freshnessValue" min="1" step="1" required
        value="${esc(f.value)}"></label>
      <label>Unit
        <select name="freshnessUnit">
          ${FRESHNESS_UNITS.map(([label, size]) => `<option value="${size}" ${size === f.unit ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
      </label>
    </div>
    <p class="muted type-help">Past this window a value is still shown, marked stale with its age,
      rather than presented as current. Set it from how fast this field actually changes and what
      the compliance owner will accept — never one global default.</p>

    ${collections.length ? `
      <label>Which collections may reference this source
        <select name="collectionIds" multiple size="${Math.min(5, Math.max(3, collections.length))}">
          ${/* A source cannot be walked into a collection you do not administer
                — the server refuses it both before and after a change — so the
                picker says so where the choice is made rather than after the
                Save. A collection this source is ALREADY scoped to stays
                selectable, or an administrator could not take it out again. */ ''}
          ${collections.map((c) => {
            const mine = !c.abilities || c.abilities.role === 'admin' || scope.includes(c.id);
            return `<option value="${esc(c.id)}" ${scope.includes(c.id) ? 'selected' : ''} ${mine ? '' : 'disabled'}
              >${esc(c.name)}${mine ? '' : ' — you do not administer this collection'}</option>`;
          }).join('')}
        </select>
      </label>
      <p class="muted type-help">Select none to leave it Canon-wide — every collection may reference
        it, and that is an act at the altitude of the whole Canon: it takes the operator role.
        Selecting collections limits it to those, and a page anywhere else cannot ask this
        source at all.</p>` : ''}`;
}

function wireSourceForm(form) {
  const warn = form.querySelector('[data-service-warn]');
  const nameEl = form.querySelector('[data-service-name]');
  const sync = () => {
    const service = [...form.querySelectorAll('input[name=authMode]')].some((r) => r.checked && r.value === 'service');
    warn.hidden = !service;
    if (nameEl) nameEl.textContent = form.name.value.trim() || 'this source';
  };
  form.querySelectorAll('input[name=authMode]').forEach((r) => r.addEventListener('change', sync));
  form.name.addEventListener('input', sync);
  sync();
}

function gatherSource(form) {
  const unit = Number(form.freshnessUnit.value) || 60000;
  const count = Math.max(1, Number(form.freshnessValue.value) || 1);
  const scopeEl = form.querySelector('select[name=collectionIds]');
  const body = {
    name: form.name.value.trim(),
    kind: form.kind.value.trim(),
    baseUrl: form.baseUrl.value.trim(),
    authMode: [...form.querySelectorAll('input[name=authMode]')].find((r) => r.checked)?.value ?? 'per_asker',
    freshnessWindowMs: count * unit,
  };
  if (scopeEl) body.collectionIds = [...scopeEl.selectedOptions].map((o) => o.value);
  return body;
}

function openSourceModal(source, collections, onDone) {
  openModal({
    title: source ? `Edit ${source.name}` : 'Register a source',
    submitLabel: source ? 'Save source' : 'Register source',
    body: sourceFormBody(source, collections),
    onSubmit: async (form) => {
      const body = gatherSource(form);
      if (source) await api('PUT', `/sources/${source.id}`, body);
      else await api('POST', '/sources', body);
      state.sourcesById = null;
      toast(source ? `Source "${body.name}" updated.` : `Source "${body.name}" registered.`, 'ok');
      onDone();
    },
  });
  wireSourceForm(document.querySelector('#modal-root form'));
}

function sourcesUnavailableHTML() {
  return `
    <div class="empty-state">
      <h2>Federated sources are not available yet</h2>
      <p>This Canon server does not serve <code>/sources</code>. Pages carry only the values
        stored in the record.</p>
      <p><a class="btn" href="#/">Back to collections</a></p>
    </div>`;
}

async function viewSources() {
  if (!(await detectSources())) {
    app.innerHTML = `<div class="page-wide">${sourcesUnavailableHTML()}</div>`;
    return;
  }
  let sources = [];
  try {
    const r = await api('GET', '/sources');
    sources = Array.isArray(r) ? r : (r?.sources ?? []);
  } catch (err) {
    if (err.status === 404 || err.status === 405) {
      state.features.sources = false;
      const link = document.getElementById('nav-sources');
      if (link) link.hidden = true;
      app.innerHTML = `<div class="page-wide">${sourcesUnavailableHTML()}</div>`;
      return;
    }
    throw err;
  }
  state.sourcesById = new Map(sources.map((s) => [s.id, s]));
  let collections = [];
  try { collections = await api('GET', '/collections'); } catch { /* names are a nicety */ }
  // USER-TESTING.md T4.4 named "a red Delete on a live data source, offered to
  // people the server refuses", and it was the last of the three still open.
  // Each row now carries what this actor may do to it, written by the same
  // function that writes a page's refusals; `GET /sources/new` answers for the
  // one control that exists before a source does. Both are absent on an older
  // server, and everything is then offered exactly as it was.
  let register = null;
  try { register = await api('GET', '/sources/new'); } catch { register = null; }
  const group = refusalGroup('these controls');

  // The rows are built BEFORE the page, so every refusal is known by the time
  // the note is written and the note can sit under the heading — beside the
  // controls it explains rather than below a table somebody has scrolled past.
  const registerHTML = group.offer(
    register,
    'Register a source',
    '<button class="btn primary" id="new-source">Register a source</button>',
    { className: 'btn primary' },
  );
  const rowsHTML = sources.length
    ? sources.map((s) => `
              <tr>
                <td>
                  <span class="source-name">${esc(s.name ?? '(unnamed)')}</span>
                  ${s.baseUrl ? `<span class="muted source-url">${esc(s.baseUrl)}</span>` : ''}
                </td>
                <td><span class="role-tag">${esc(s.kind ?? '—')}</span></td>
                <td class="source-mode">${authModeCell(s.authMode)}</td>
                <td class="source-scope">${sourceScopeCell(s, collections)}</td>
                <td class="nowrap">${esc(fmtDuration(s.freshnessWindowMs))}</td>
                <td class="t-right nowrap">
                  ${group.offer(
                    s.abilities?.edit ?? null,
                    'Edit',
                    `<button class="btn subtle" data-edit-source="${esc(s.id)}">Edit</button>`,
                    { className: 'btn subtle' },
                  )}
                  ${group.offer(
                    s.abilities?.delete ?? null,
                    'Delete',
                    `<button class="btn subtle" data-delete-source="${esc(s.id)}">Delete</button>`,
                    { className: 'btn subtle' },
                  )}
                </td>
              </tr>`).join('')
    : group.offer(
        register,
        'Register the first source',
        '<button class="btn primary" id="new-source-empty">Register the first source</button>',
        { className: 'btn primary' },
      );

  app.innerHTML = `
    <div class="page-wide">
      <div class="page-head">
        <div>
          <h1>Sources</h1>
          <p class="muted sources-lede">External systems Canon reads from and never copies. A page
            holds a reference — the key to ask with — and the value is resolved when the page is
            read, shown with the source that answered and the time it answered.</p>
        </div>
        <div class="actions">${registerHTML}</div>
      </div>
      ${group.noteHTML()}

      ${sources.length ? `
        <div class="table-scroll"><table class="table sources-table">
          <thead><tr><th>Name</th><th>Kind</th><th>Resolved as</th><th>Referenceable from</th><th>Freshness window</th><th></th></tr></thead>
          <tbody>
            ${rowsHTML}
          </tbody>
        </table></div>` : `
        <div class="empty-state">
          <h2>No sources registered</h2>
          <p>Register the system that owns a fact — the HRIS for headcount, the benefits
            administrator for a deductible — and pages can reference its values instead of
            asserting numbers Canon does not own and cannot keep true.</p>
          <p>${rowsHTML}</p>
        </div>`}
    </div>`;

  const reload = () => route();
  app.querySelector('#new-source')?.addEventListener('click', () => openSourceModal(null, collections, reload));
  app.querySelector('#new-source-empty')?.addEventListener('click', () => openSourceModal(null, collections, reload));

  app.querySelectorAll('[data-edit-source]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const source = sources.find((s) => s.id === btn.dataset.editSource);
      if (source) openSourceModal(source, collections, reload);
    });
  });

  app.querySelectorAll('[data-delete-source]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const source = sources.find((s) => s.id === btn.dataset.deleteSource);
      if (!source) return;
      openModal({
        title: `Delete ${source.name}`,
        submitLabel: 'Delete source',
        danger: true,
        body: `
          <p>Canon will no longer resolve values from <strong>${esc(source.name)}</strong>.</p>
          <p class="muted">Pages that reference it keep their references and will show them as
            unresolved, naming this source — a reference is never silently dropped, because a
            missing value must not read as "there is no such value".</p>`,
        onSubmit: async () => {
          await api('DELETE', `/sources/${source.id}`);
          state.sourcesById = null;
          toast(`Source "${source.name}" deleted.`, 'ok');
          reload();
        },
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Imports (CORE-PLAN.md Epic E, M4) — the screen for a server that was
// finished and unreachable
//
// Round seven, tester 25, a migration engineer: "There is no import UI at all
// — verified as both member and administrator." Everything underneath was
// already built. `POST /imports`, `POST /imports/upload`, `GET /imports` and
// `GET /imports/:id` are wired over a complete importer with Confluence and
// Google Docs discovery, a file cap, per-file outcomes, run records and
// idempotent re-runs — and `app.js` contained zero references to any of it.
// The one failed file in that tester's corpus was discoverable only by
// filtering the audit log to `import.page` and reading a details blob.
//
// So this is a renderer, and deliberately little else. Everything it shows was
// in `ImportFileResult` and `ImportRunRecord` before it existed:
//
//   * THE RUN LIST, which is what "did the migration happen, and what came of
//     it" looks like when it is a screen instead of a log query.
//   * THE PER-FILE OUTCOME TABLE, with the reason each file gives — including
//     the truncation cause (`html.ts::truncationNote`), which is the
//     difference between "the file parsed to an empty document" and "the
//     export ends inside an unclosed comment, so re-export this page". One
//     sends an operator back to the source system looking for a page that is
//     not empty; the other tells them what to do.
//   * A RE-RUN, which needs no new server anything: a run id re-used skips
//     files whose content is unchanged and retries the ones that failed. That
//     IS the retry three testers asked for, and it has existed all along.
//
// WHAT THE SCREEN MAY OFFER is `collectionAbilities.runImport` — `admin` on
// the collection the pages land in, and nothing else (import.ts: "ADMIN, NOT
// EDIT"). The picker is built from it rather than from membership, so the
// collections on offer are exactly the ones the server would accept a run for,
// and the refusal a reader meets is the sentence the server would have thrown.

const IMPORT_SOURCE_LABELS = { confluence: 'Confluence', 'google-docs': 'Google Docs' };
const IMPORT_SOURCES = ['confluence', 'google-docs'];
const IMPORT_OUTCOME_LABELS = { imported: 'Imported', updated: 'Updated', skipped: 'Skipped', failed: 'Failed' };
// How a run recovered the page tree, in the words of somebody who has to
// decide whether the result is good enough to keep.
const IMPORT_HIERARCHY_NOTES = {
  tree: 'The export listed its own page tree, and the pages nest the way they did in the source system.',
  breadcrumbs: 'The export carried no index, so the nesting was recovered from each page’s own breadcrumbs.',
  flat: 'Nothing in the export described a page tree, so every page arrived at the top level.',
};

let importsProbe = null;

/**
 * Whether this Canon serves imports AND this reader has anything to do with
 * them. Two questions, because the nav is seven entries already and an eighth
 * that opens onto an empty screen somebody may never be able to use is worse
 * than no entry: it is offered to anyone who can START a run, and to anyone
 * with a run to read, and to nobody else.
 */
async function detectImports() {
  if (state.features.imports === null) {
    importsProbe ??= (async () => {
      let runs;
      try {
        runs = await api('GET', '/imports');
      } catch (err) {
        // 404/405 is a server without the route; anything else means the route
        // is there and something else went wrong, which is not this probe's
        // business to hide.
        return err.status !== 404 && err.status !== 405 && err.status !== 0;
      }
      if (Array.isArray(runs) && runs.length) return true;
      try {
        const collections = await api('GET', '/collections');
        return collections.some((c) => c.abilities?.runImport?.can === true);
      } catch {
        return false;
      }
    })();
    const found = await importsProbe;
    importsProbe = null;
    if (state.features.imports === null) state.features.imports = found;
  }
  const link = document.getElementById('nav-imports');
  if (link) link.hidden = state.features.imports !== true;
  return state.features.imports === true;
}

/**
 * The uploaded-archive door. Everything about it is `api()` except the body,
 * which is the file itself rather than JSON — the run's parameters ride the
 * query string precisely because the body is a corpus.
 */
async function apiUpload(path, file) {
  const headers = { 'Content-Type': 'application/zip' };
  const cookieSession = state.auth?.viaCookie === true;
  const actorId = cookieSession ? null : state.actor?.id;
  if (actorId) headers['X-Actor-Id'] = actorId;
  if (cookieSession && state.auth?.csrfToken) {
    headers[state.auth.csrfHeader ?? 'X-Canon-CSRF'] = state.auth.csrfToken;
  }
  let res;
  try {
    res = await fetch(path, { method: 'POST', headers, credentials: 'same-origin', body: file });
  } catch {
    throw { status: 0, code: 'network', message: 'Cannot reach the Canon server.', details: {} };
  }
  // A run lands pages, which changes what is waiting on people; the cached
  // queue is dropped exactly as `api()` drops it after any write.
  state.queue.at = 0;
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) {
    throw {
      status: res.status,
      code: data?.error ?? 'error',
      message: data?.message ?? `The upload failed (${res.status})`,
      details: data ?? {},
    };
  }
  return data;
}

function importOutcomeHTML(outcome) {
  const label = IMPORT_OUTCOME_LABELS[outcome] ?? outcome;
  return `<span class="import-outcome import-outcome-${esc(outcome)}">${esc(label)}</span>`;
}

/** "6 imported · 1 failed" — the counts that are not zero, and never "0 failed". */
function importCountsHTML(counts = {}) {
  const parts = ['imported', 'updated', 'skipped', 'failed']
    .filter((k) => Number(counts[k]) > 0)
    .map((k) => `<span class="import-count import-count-${k}">${Number(counts[k])} ${k}</span>`);
  if (!parts.length) return '<span class="muted">nothing to import</span>';
  return parts.join(' · ');
}

/**
 * What a run put on every page it landed. The importer asks once per run
 * (import.ts, ImportRunFields) and this is where the answer is READ BACK —
 * "Owner —, Approver —, Review due —" across nine pages was the finding, and
 * a run that names nobody must say so here rather than showing an empty row.
 */
function importFieldsHTML(run) {
  const fields = run?.fields ?? {};
  const rules = TYPE_FIELDS[run?.type] ?? {};
  const rows = [];
  if (rules.owner) rows.push(['Owner', fields.ownerId ? esc(actorName(fields.ownerId)) : '<span class="muted">nobody named</span>']);
  if (rules.approver) {
    rows.push(['Approver', fields.approverId ? esc(actorName(fields.approverId)) : '<span class="muted">nobody named</span>']);
  }
  if (rules.reviewDate) {
    rows.push(['Review date', fields.reviewDate ? esc(fmtDate(fields.reviewDate)) : '<span class="muted">none set</span>']);
  }
  if (!rows.length) {
    return `<p class="muted">A ${esc(TYPE_LABELS[run?.type] ?? run?.type)} carries no owner, no approver and no
      review date — it never holds the Canonical mark, so it has none of those to carry.</p>`;
  }
  return `<dl class="field-block import-fields">${rows
    .map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`)
    .join('')}</dl>`;
}

function importsUnavailableHTML() {
  return `
    <div class="empty-state">
      <h2>Imports are not available on this server</h2>
      <p>This Canon server does not serve <code>/imports</code>. Pages arrive by being written here.</p>
      <p><a class="btn" href="#/">Back to collections</a></p>
    </div>`;
}

/**
 * Why the "Import an export" control is refused, in the server's own words
 * where there is exactly one sentence to quote.
 *
 * With several collections there is no single server sentence — the reader
 * holds a different role on each — so what is said instead DESCRIBES THE
 * LISTING rather than making a claim about the record (the rule Phase 1.1 and
 * 1.5 established). It never says "you cannot import", which would be a claim
 * about collections this reader may not even be a member of.
 */
function importRefusalWhy(collections) {
  if (!collections.length) {
    return 'Importing needs the admin role on the collection the pages land in, and you belong to no ' +
      'collection yet. An administrator of a collection can grant it.';
  }
  if (collections.length === 1) {
    return collections[0].abilities?.runImport?.why ??
      'Importing needs the admin role on the collection the pages land in.';
  }
  return `Importing needs the admin role on the collection the pages land in; you administer none of the ` +
    `${collections.length} collections you belong to. An administrator of a collection can grant it.`;
}

async function viewImports() {
  markNav('imports');
  let runs = [];
  try {
    runs = await api('GET', '/imports');
  } catch (err) {
    if (err.status === 404 || err.status === 405) {
      state.features.imports = false;
      const link = document.getElementById('nav-imports');
      if (link) link.hidden = true;
      app.innerHTML = `<div class="page-wide">${importsUnavailableHTML()}</div>`;
      return;
    }
    throw err;
  }
  let collections = [];
  try { collections = await api('GET', '/collections'); } catch { /* names and abilities are both nice-to-have */ }
  await loadActors().catch(() => null);
  const byId = new Map(collections.map((c) => [c.id, c]));
  const importable = collections.filter((c) => c.abilities?.runImport?.can === true);

  const group = refusalGroup('these controls');
  const startHTML = importable.length
    ? '<button class="btn primary" id="new-import">Import an export</button>'
    : group.refuse('Import an export', importRefusalWhy(collections), { className: 'btn primary' });

  const rows = runs.map((r) => `
    <tr>
      <td>
        <a href="#/imports/${esc(r.runId)}">${esc(IMPORT_SOURCE_LABELS[r.source] ?? r.source)} into
          ${esc(byId.get(r.collectionId)?.name ?? 'a collection')}</a>
        <div class="import-meta muted">${esc(TYPE_LABELS[r.type] ?? r.type)} pages · run by
          ${esc(actorName(r.actorId))}</div>
      </td>
      <td class="import-counts">${importCountsHTML(r.counts)}</td>
      <td class="nowrap">${esc(fmtAgo(r.startedAt) ?? '')}
        <div class="import-meta muted">${esc(fmtDateTime(r.startedAt))}</div></td>
    </tr>`).join('');

  app.innerHTML = `
    <div class="page-wide">
      <div class="page-head">
        <div>
          <h1>Imports</h1>
          <p class="muted imports-lede">Everything Canon has brought in from another system, and what became
            of every file. Imported pages arrive as drafts — nothing an import lands carries the Canonical
            mark, whoever ran it.</p>
        </div>
        <div class="actions">${startHTML}</div>
      </div>
      ${group.noteHTML()}
      ${runs.length ? `
        <div class="table-scroll"><table class="table imports-table">
          <thead><tr><th>Run</th><th>Outcome</th><th>Started</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
        <p class="muted">Open a run to see every file it read, why any of them failed, and to run it again —
          a re-run skips the files that have not changed and retries the ones that did not land.</p>` : `
        <div class="empty-state">
          <h2>No import has been run${collections.length ? ' in a collection you belong to' : ''}</h2>
          <p>A Confluence space export or a folder of Google Docs exports arrives as draft pages, keeping the
            page tree where the export describes one. Every file gets an outcome you can read, and nothing
            becomes Canonical without passing through review.</p>
        </div>`}
    </div>`;

  app.querySelector('#new-import')?.addEventListener('click', () => openImportModal(importable));
}

async function viewImportRun(runId) {
  markNav('imports');
  let run;
  try {
    run = await api('GET', `/imports/${encodeURIComponent(runId)}`);
  } catch (err) {
    renderErrorPage(err);
    return;
  }
  let collections = [];
  try { collections = await api('GET', '/collections'); } catch { /* as above */ }
  await loadActors().catch(() => null);
  const collection = collections.find((c) => c.id === run.collectionId) ?? null;

  // The titles a run reported for its files are not on the stored record —
  // `import_items` keeps the file, the page and the outcome. Where this is the
  // run that has just finished in this tab, its own summary fills them in;
  // otherwise the file name stands, which is what the record actually holds.
  const titles = new Map(
    state.lastImport?.runId === run.runId
      ? (state.lastImport.files ?? []).filter((f) => f.title).map((f) => [f.file, f.title])
      : [],
  );
  const items = run.items ?? [];
  const failed = items.filter((i) => i.outcome === 'failed').length;

  const group = refusalGroup('these controls');
  const canRerun = collection?.abilities?.runImport ?? null;
  const rerunHTML = group.offer(
    canRerun,
    'Run again',
    '<button class="btn primary" id="rerun-import">Run again</button>',
    { className: 'btn primary' },
  );
  const reuploadHTML = group.offer(
    canRerun,
    'Run again from a file',
    '<button class="btn subtle" id="reupload-import">Run again from a file…</button>',
    { className: 'btn subtle' },
  );

  const rows = items.map((i) => `
    <tr class="import-row import-row-${esc(i.outcome)}">
      <td>
        <span class="import-file">${esc(i.file)}</span>
        ${titles.get(i.file) ? `<div class="import-meta muted">${esc(titles.get(i.file))}</div>` : ''}
      </td>
      <td class="nowrap">${importOutcomeHTML(i.outcome)}</td>
      <td>${i.reason ? esc(i.reason) : '<span class="muted">—</span>'}</td>
      <td class="nowrap">${i.pageId
        ? `<a href="#/pages/${esc(i.pageId)}">Open the page</a>`
        : '<span class="muted">no page</span>'}</td>
    </tr>`).join('');

  app.innerHTML = `
    <div class="page-wide">
      <div class="page-head">
        <div>
          <h1>${esc(IMPORT_SOURCE_LABELS[run.source] ?? run.source)} into
            ${esc(collection?.name ?? 'a collection')}</h1>
          <p class="muted">Run by ${esc(actorName(run.actorId))} · started ${esc(fmtDateTime(run.startedAt))}${
            run.finishedAt ? ` · finished ${esc(fmtDateTime(run.finishedAt))}` : ' · <strong>not finished</strong>'
          }</p>
        </div>
        <div class="actions"><a class="btn subtle" href="#/imports">All imports</a>${rerunHTML}${reuploadHTML}</div>
      </div>
      ${group.noteHTML()}

      <section class="import-summary">
        <p class="import-counts">${importCountsHTML(run.counts)}
          <span class="muted"> — ${Number(run.counts?.found ?? 0)} document${
            Number(run.counts?.found ?? 0) === 1 ? '' : 's'} found</span></p>
        <p class="muted">${esc(IMPORT_HIERARCHY_NOTES[run.hierarchy] ?? '')}</p>
        <p class="muted import-path">Read from <code>${esc(run.path)}</code> · run id
          <code>${esc(run.runId)}</code></p>
      </section>

      <section class="import-section">
        <h2>What every page it landed carries</h2>
        ${importFieldsHTML(run)}
      </section>

      <section class="import-section">
        <h2>Every file</h2>
        ${failed ? `<p class="import-failed-lede">${failed} file${failed === 1 ? '' : 's'} did not land. Running
          this import again keeps everything that did and tries these once more.</p>` : ''}
        ${items.length ? `
          <div class="table-scroll"><table class="table import-files">
            <thead><tr><th>File</th><th>Outcome</th><th>What happened</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table></div>` : `
          <p class="muted">This run recorded no files. Either the export held no documents Canon could
            recognise, or the run did not finish.</p>`}
      </section>
    </div>`;

  app.querySelector('#rerun-import')?.addEventListener('click', () => confirmRerun(run, collection));
  app.querySelector('#reupload-import')?.addEventListener('click', () =>
    openImportModal(collection ? [collection] : [], { run }));
}

/**
 * Running the same run again. Not a confirmation for ceremony's sake: what a
 * re-run does is genuinely not obvious, and the wrong mental model ("it will
 * import everything twice") is exactly what stopped the testers who had a
 * failed file from trying it.
 */
function confirmRerun(run, collection) {
  openModal({
    title: 'Run this import again',
    submitLabel: 'Run it again',
    body: `
      <p>Canon reads <code>${esc(run.path)}</code> again, under the same run id.</p>
      <ul class="muted import-rerun-notes">
        <li>A file whose content has not changed is skipped — no second page, no second version.</li>
        <li>A file that changed becomes a new version of the page it already made.</li>
        <li>A file that failed is tried again.</li>
      </ul>
      <p class="muted">Every page still lands as a draft, with the owner, approver and review date this run
        recorded.</p>`,
    onSubmit: async () => {
      let summary;
      try {
        summary = await api('POST', '/imports', {
          source: run.source,
          path: run.path,
          collectionId: run.collectionId,
          type: run.type,
          runId: run.runId,
          fields: run.fields ?? undefined,
        });
      } catch (err) {
        // The one refusal a reader cannot act on from the server's words
        // alone. A run that arrived as an uploaded file recorded the folder
        // the archive was unpacked into, and the server removed it the moment
        // the run finished (import.ts clears the spool in a `finally`) — so
        // "no such export directory" is true, expected, and says nothing about
        // the way forward, which is on this screen beside this button.
        if (err?.status === 404) {
          throw {
            ...err,
            message: `${err.message} If this run came from a file somebody uploaded, Canon removed its copy ` +
              'when the run finished — "Run again from a file…" takes the same export again, under this same run id.',
          };
        }
        throw err;
      }
      state.lastImport = summary;
      toast(`Run again: ${summary.counts.imported} imported, ${summary.counts.updated} updated, ` +
        `${summary.counts.skipped} skipped, ${summary.counts.failed} failed.`, 'ok');
      route();
    },
  });
}

/**
 * The one dialog that starts a run, from either door.
 *
 * `opts.run` re-runs an existing run — same id, same collection, same type —
 * which is how an import that arrived as an uploaded file is retried: the
 * archive is gone from the server the moment the run finished (import.ts
 * removes the spool in a `finally`), so "run again" from a path would send an
 * operator to a folder that no longer exists. Uploading the same export under
 * the same run id lands on the same idempotency.
 */
async function openImportModal(collections, opts = {}) {
  const rerun = opts.run ?? null;
  const people = await loadActors().catch(() => []);
  const me = state.actor?.id ?? '';
  const first = rerun ? collections.find((c) => c.id === rerun.collectionId) ?? collections[0] : collections[0];
  if (!first) {
    toast('Importing needs the admin role on the collection the pages land in.');
    return;
  }
  const type = rerun?.type ?? 'note';
  let approvers = await loadApproveHolders(first.id);

  const sourceOptions = IMPORT_SOURCES.map((s) =>
    `<option value="${esc(s)}" ${s === (rerun?.source ?? 'confluence') ? 'selected' : ''}>${esc(IMPORT_SOURCE_LABELS[s])}</option>`).join('');
  const collectionOptions = collections.map((c) =>
    `<option value="${esc(c.id)}" ${c.id === first.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  const typeOptions = Object.keys(TYPE_LABELS).map((t) =>
    `<option value="${esc(t)}" ${t === type ? 'selected' : ''}>${esc(TYPE_LABELS[t])}</option>`).join('');
  const ownerOptions = `<option value="">—</option>` + people.map((p) =>
    `<option value="${esc(p.id)}" ${p.id === (rerun?.fields?.ownerId ?? me) ? 'selected' : ''}>${esc(p.name)}${
      p.id === me ? ' (you)' : ''}</option>`).join('');

  const dialog = openModal({
    title: rerun ? 'Run this import again from a file' : 'Import an export',
    submitLabel: rerun ? 'Upload and run again' : 'Import',
    body: `
      <label>What it came out of
        <select name="source" ${rerun ? 'disabled' : ''}>${sourceOptions}</select></label>
      <label>Which collection the pages land in
        <select name="collectionId" ${rerun ? 'disabled' : ''}>${collectionOptions}</select></label>
      <label>What each page becomes
        <select name="type" ${rerun ? 'disabled' : ''}>${typeOptions}</select></label>
      <p class="muted type-help" data-type-help></p>

      ${rerun ? '' : `
        <fieldset class="import-where">
          <legend>Where the export is</legend>
          <label class="check"><input type="radio" name="where" value="upload" checked>
            A file I have here (a <code>.zip</code> export)</label>
          <label class="check"><input type="radio" name="where" value="path">
            A folder already on the Canon server</label>
        </fieldset>`}
      <label data-where="upload">The export file
        <input type="file" name="archive" accept=".zip,application/zip"></label>
      ${rerun ? '' : `
        <label data-where="path">The folder on the server
          <input type="text" name="path" placeholder="/srv/exports/confluence-space" autocomplete="off"></label>`}

      <div data-owner-fields>
        <label data-field="owner">Who owns these pages
          <select name="ownerId">${ownerOptions}</select></label>
        <label data-field="approver">Who will approve them
          <select name="approverId">${approverOptionsHTML(approvers, rerun?.fields?.approverId ?? null)}</select></label>
        <label data-field="reviewDate">When they should next be read
          <input type="date" name="reviewDate" value="${esc(rerun?.fields?.reviewDate ?? '')}"></label>
      </div>
      <p class="muted import-fields-note" data-fields-note></p>
      <p class="muted">Every page arrives as a draft. A large export takes a while, and this dialog stays
        open until the run has finished and can tell you what happened to each file.</p>`,
    onSubmit: async (form) => {
      const chosenType = form.type.value;
      const rules = TYPE_FIELDS[chosenType] ?? {};
      const fields = {};
      if (rules.owner && form.ownerId.value) fields.ownerId = form.ownerId.value;
      if (rules.approver && form.approverId.value) fields.approverId = form.approverId.value;
      if (rules.reviewDate && form.reviewDate.value) fields.reviewDate = form.reviewDate.value;
      const collectionId = form.collectionId.value;
      const where = rerun ? 'upload' : form.where.value;

      let summary;
      if (where === 'upload') {
        const file = form.archive.files?.[0];
        if (!file) throw { message: 'Choose the export file first.' };
        const query = new URLSearchParams({ source: form.source.value, collectionId, type: chosenType });
        if (rerun) query.set('runId', rerun.runId);
        for (const [key, value] of Object.entries(fields)) query.set(key, value);
        summary = await apiUpload(`/imports/upload?${query.toString()}`, file);
      } else {
        const path = form.path.value.trim();
        if (!path) throw { message: 'Say which folder on the server holds the export.' };
        summary = await api('POST', '/imports', {
          source: form.source.value,
          path,
          collectionId,
          type: chosenType,
          fields,
        });
      }
      state.lastImport = summary;
      toast(`${summary.counts.imported} imported, ${summary.counts.updated} updated, ` +
        `${summary.counts.skipped} skipped, ${summary.counts.failed} failed.`, 'ok');
      location.hash = `#/imports/${summary.runId}`;
      // Landing on the run's own screen is the point: the counts are the
      // headline and the per-file reasons are the work.
      route();
    },
  });

  const form = dialog.form;
  // Which of the three fields the chosen type actually carries. The editor
  // follows TYPE_FIELDS for exactly this reason, and the importer refuses a
  // field its type does not carry — so a form that offered all three would be
  // collecting an answer the server is about to throw back.
  const syncType = () => {
    const chosen = form.type.value;
    const rules = TYPE_FIELDS[chosen] ?? {};
    for (const key of ['owner', 'approver', 'reviewDate']) {
      const row = form.querySelector(`[data-field="${key}"]`);
      if (row) row.hidden = !rules[key];
    }
    const help = form.querySelector('[data-type-help]');
    if (help) help.textContent = TYPE_HELP[chosen] ?? '';
    const note = form.querySelector('[data-fields-note]');
    if (note) {
      note.textContent = rules.owner
        ? 'Asked once, and written onto every page this run lands.' + (
          chosen === 'policy'
            ? ' A Policy also needs the day it began to apply, which is a fact about each document — those' +
              ' pages arrive with their text in the draft, and the run says so file by file.'
            : '')
        : `A ${TYPE_LABELS[chosen] ?? chosen} carries no owner, no approver and no review date: it never holds` +
          ' the Canonical mark, so it has none of those to carry.';
    }
  };
  const syncWhere = () => {
    const where = rerun ? 'upload' : form.where.value;
    for (const key of ['upload', 'path']) {
      const row = form.querySelector(`[data-where="${key}"]`);
      if (row) row.hidden = key !== where;
    }
  };
  form.type.addEventListener('change', syncType);
  form.querySelectorAll('[name="where"]').forEach((radio) => radio.addEventListener('change', syncWhere));
  // The approver list belongs to the collection, so it is re-read when the
  // collection changes: a picker left behind from another collection offers
  // names the server will refuse (approverOptionsHTML, above).
  form.collectionId.addEventListener('change', async () => {
    approvers = await loadApproveHolders(form.collectionId.value);
    form.approverId.innerHTML = approverOptionsHTML(approvers, null);
  });
  syncType();
  syncWhere();
}

// ---------------------------------------------------------------------------
// Grounded answers
//
// The contract (DATA-BACKBONE.md §5):
//   POST /ask { question, collectionId?, limit? }
//     -> { answer: string|null,
//          citations: [{ pageId, title, version, snippet, status? }],
//          refused: boolean, reason?: "no_canonical_match",
//          pastReview?: [{ pageId, title }],
//          disagreement?: { pageIds: [...], note } }
//
// A citation's `status` is the standing of the page behind the quotation —
// `canonical`; `needs_update` when it is past its review date; `in_review`
// when an edit is pending while the quoted, approved version goes on serving
// (the server cites nothing unreviewed — see ANSWERABLE_STATUSES). It is the
// most trust-bearing thing on this screen, so it is rendered ONLY when the
// server sent it. See `citationBadge` below for why there is no default.
//
// Three things the UI has to carry, because they are the product's promises:
// every claim is verifiable by clicking through to the cited page and version;
// a refusal is a correct answer about a silent record — never an error; and
// where the cited passages disagree, the answer says so, cites both, and does
// not choose (DATA-BACKBONE.md §7). The last of those is optional in the
// payload and feature-detected by its absence: a server that never sends it
// renders exactly the Ask view that was here before.

const ASK_EXAMPLES = [
  'How long do we retain audit logs?',
  'Who approves a change to a Policy?',
  'What has to be true before a spec is Canonical?',
];

function normalizeCitation(c, i = 0) {
  return {
    n: i + 1,
    pageId: c.pageId ?? c.id ?? c.page?.id ?? null,
    title: c.title ?? c.pageTitle ?? c.page?.title ?? '(untitled page)',
    version: c.version ?? c.versionNumber ?? c.currentVersion ?? null,
    snippet: c.snippet ?? c.excerpt ?? '',
    status: c.status ?? null,
    disputed: c.disputed ?? null,
    fields: Array.isArray(c.fields) ? c.fields : null,
  };
}

// The status badge on a source card, and the one place in the Ask view allowed
// to draw one.
//
// It used to fall back to the Canonical mark whenever a citation arrived
// without a status, and the server had never sent one — so every source card
// printed CANONICAL, including cards for pages the same answer's prose was
// calling past review. A default is a claim, and defaulting to the most
// trust-bearing value in the product is the most expensive claim available:
// the badge said "approved and current" with nothing behind it. There is no
// fallback here for that reason. A server that does not send a status gets no
// badge, the card still names the page and its version, and the reader clicks
// through — one click is cheaper than one false CANONICAL.
function citationBadge(c) {
  return c.status ? badge(c.status, 'sm') : '';
}

// Turn "[1]" style markers in the answer into buttons that jump to the
// citation. Operates on the HTML renderMarkdown() produced: the alternation
// passes tags through untouched, so only escaped text is ever rewritten, and
// the markup inserted is entirely our own.
function linkifyCitationMarkers(html, count) {
  if (!count) return html;
  // The space before a marker is swallowed so it sits against the word it
  // supports, the way a footnote mark does.
  return html.replace(/(<[^>]*>)|[ \t]?\[(\d+)\]/g, (m, tag, num) => {
    if (tag) return tag;
    const n = Number(num);
    if (n < 1 || n > count) return m;
    return `<button type="button" class="cite-ref" data-cite="${n}"
      title="Jump to source ${n}" aria-label="Source ${n}">${n}</button>`;
  });
}

function askSkeletonHTML() {
  return `
    <div class="ask-skeleton" aria-hidden="true">
      <p class="h-small">Reading the Canonical record&hellip;</p>
      <div class="skel-line" style="width: 96%"></div>
      <div class="skel-line" style="width: 88%"></div>
      <div class="skel-line" style="width: 92%"></div>
      <div class="skel-line" style="width: 54%"></div>
      <div class="skel-cites">
        <div class="skel-line skel-cite" style="width: 100%"></div>
        <div class="skel-line skel-cite" style="width: 100%"></div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// When the passages an answer drew on disagree (DATA-BACKBONE.md §7)
//
//   AnswerResponse may carry:  disagreement?: { pageIds: [...], note }
//
// §7 calls this the sharpest rule in the section: "when the passages an answer
// draws on conflict, the answer says so, cites both, and does not choose. The
// record gives two answers here and they differ is a correct, useful answer."
//
// So this is drawn as the product demonstrating its own integrity, not as a
// failure. It is not red, it is not a warning triangle, and it does not
// apologise: it is the most confident thing on the screen, above the answer,
// because at this exact moment it is the most valuable thing on the screen. An
// answer that had smoothed the contradiction into one fluent sentence would
// look better and be worth far less.
//
// Read straight off the answer payload — there is nothing to feature-detect,
// because a server that never sends the field simply never renders this, and
// the Ask view is exactly what it was before.

function normalizeDisagreement(d, citations) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const note = String(d.note ?? '').trim();
  const ids = [...new Set((Array.isArray(d.pageIds) ? d.pageIds : []).map((id) => String(id ?? '')).filter(Boolean))];
  if (!ids.length && !note) return null;
  const byId = new Map(citations.map((c) => [c.pageId, c]));
  return {
    note,
    pages: ids.map((id) => ({ id, cite: byId.get(id) ?? null })),
  };
}

function disagreementHTML(dg) {
  const pages = dg.pages.map((p) => {
    const c = p.cite;
    const title = c ? c.title : 'A cited page';
    const meta = c
      ? `${citationBadge(c)}${c.version ? `<span class="citation-version">v${esc(c.version)}</span>` : ''}`
      : `<span class="muted dg-unknown">page ${esc(clip(p.id, 12))}</span>`;
    return `
      <li class="dg-page">
        <a class="dg-page-link" href="#/pages/${esc(p.id)}">
          <span class="dg-page-main">
            <span class="dg-page-title">${esc(title)}</span>
            ${meta}
          </span>
          ${c && c.snippet ? `<span class="dg-page-snippet">${esc(clip(c.snippet, 180))}</span>` : ''}
          <span class="dg-page-go" aria-hidden="true">→</span>
        </a>
      </li>`;
  }).join('');
  return `
    <section class="disagreement" aria-labelledby="dg-title">
      <div class="dg-head">
        <span class="dg-mark">Two answers</span>
        <h2 id="dg-title">The record gives two answers here, and they differ.</h2>
      </div>
      ${dg.note ? `<p class="dg-note">${esc(dg.note)}</p>` : ''}
      ${pages ? `
        <p class="dg-lede">Both, cited, unchanged — read either one:</p>
        <ul class="dg-pages">${pages}</ul>` : `
        <p class="dg-lede">The pages this draws on are cited below; two of them do not agree.</p>`}
      <p class="dg-foot">Canon has not chosen between them and the answer below does not either. Reading two
        conflicting passages into one fluent sentence is the one thing a knowledge record must never do — it would
        look more certain and be worth far less. Both pages are official; which of them is right is a decision for
        the person who owns them.</p>
    </section>`;
}

function citationsHTML(citations, disputed = new Set()) {
  const items = citations.map((c) => {
    const head = `
      <span class="citation-num" aria-hidden="true">${c.n}</span>
      <span class="citation-main">
        <span class="citation-title-row">
          <span class="citation-title">${esc(c.title)}</span>
          ${citationBadge(c)}
          ${c.version ? `<span class="citation-version">v${esc(c.version)}</span>` : ''}
          ${/* The pill is drawn from the CITATION, so it is a property of the
                page rather than of this query. It used to come from the set of
                pages in this answer's disagreement, which meant the same page,
                at the same version, showed "in disagreement" in one answer and
                nothing at all in another — the standing changing with the
                phrasing of the question. */ ''}
          ${c.disputed
            ? `<span class="citation-disputed" title="${esc(
                (c.disputed.withTitles.length
                  ? `The record holds an asserted conflict between this page and ${c.disputed.withTitles.join(' and ')}.`
                  : 'The record holds an asserted conflict against this page.') +
                  ` ${c.disputed.assertedByName} asserted it: “${c.disputed.note}”` +
                  (disputed.has(c.pageId) ? ' Both sides are cited here; neither has been chosen.' : ''),
              )}">${disputed.has(c.pageId) ? 'in disagreement' : 'contested'}</span>`
            : ''}
        </span>
        ${c.snippet ? `<span class="citation-snippet">${esc(c.snippet)}</span>` : ''}
      </span>`;
    const body = c.pageId
      ? `<a class="citation-link" href="#/pages/${esc(c.pageId)}">${head}<span class="citation-go" aria-hidden="true">→</span></a>`
      : `<div class="citation-link is-plain">${head}</div>`;
    const foot = c.pageId && c.version
      ? `<p class="citation-foot"><a href="#/pages/${esc(c.pageId)}/versions/${esc(c.version)}">Read v${esc(c.version)} exactly as cited</a></p>`
      : '';
    // The cited page's federated fields, so the LIVE figure stands beside the
    // quoted prose. A compliance director asked for the PLAN-7 deductible and
    // the only number on his screen was the stale one — correctly framed as
    // contested, still the wrong number, while the live value sat on the page
    // the answer itself cited. Values render exactly as the page shows them:
    // last-known, freshness stated, an error carried rather than papered over.
    const fields = Array.isArray(c.fields) && c.fields.length
      ? `<ul class="citation-fields">${c.fields.map((f) => `
          <li><span class="cf-label">${esc(f.label)}</span>
            <span class="cf-value">${esc(String(f.value ?? '—'))}</span>
            <span class="muted">from ${esc(f.sourceName)}${f.role === 'corroboration' ? ' (corroborating)' : ''}${
              f.stale ? ' · STALE' + (f.error ? ` — ${esc(f.error)}` : '') : ' · within freshness window'
            }</span></li>`).join('')}
        </ul>`
      : '';
    return `<li class="citation ${disputed.has(c.pageId) ? 'is-disputed' : ''}" data-citation="${c.n}">${body}${fields}${foot}</li>`;
  }).join('');
  const n = citations.length;
  return `
    <section class="citations">
      <h2 class="h-small">${n} source${n === 1 ? '' : 's'}</h2>
      <p class="citations-note">Every claim above comes from these pages. Open any one to
        check it against the record — the answer is only as official as what it cites.</p>
      <ol class="citation-list">${items}</ol>
    </section>`;
}

function answerHTML(answer, citations, disagreement = null) {
  const n = citations.length;
  const disputed = new Set((disagreement?.pages ?? []).map((p) => p.id));
  // The grounding line is a claim about the sources, so it counts them rather
  // than describing them from memory. A Needs Update page is still Canonical —
  // it is Canonical AND overdue — but a line reading "drawn from 2 Canonical
  // pages" above a card badged NEEDS UPDATE reads as a contradiction, and the
  // reader is right to trust the badge over the summary.
  const stale = citations.filter((c) => c.status === 'needs_update').length;
  const staleNote = !stale
    ? ''
    : stale === n
      ? n === 1 ? ', past its review date' : ', all past their review date'
      : `, ${stale} of them past review`;
  // There is no thin rendering any more, because a thin verdict never arrives
  // here: the server refuses it, and the refusal screen names the near pages
  // as places to look. "Closest passages" wearing an answer's clothes —
  // cited, quoted, refused:false — was the fourth persona round's headline
  // finding, in three surfaces at once. An answer that reaches this function
  // cleared the grounding bar.
  return `
    ${disagreement ? disagreementHTML(disagreement) : ''}
    <article class="answer ${disagreement ? 'is-contested' : ''}">
      <div class="answer-head">
        <h2 class="h-small">Answer</h2>
        <span class="answer-grounding">drawn from ${n} Canonical page${n === 1 ? '' : 's'}${staleNote}${disagreement ? ', which do not agree' : ''}</span>
      </div>
      <div class="answer-body">${linkifyCitationMarkers(renderMarkdown(answer), n)}</div>
    </article>
    ${citationsHTML(citations, disputed)}`;
}

// The content words of a question, for handing a natural-language question to
// a keyword search. Lowercase alphanumeric runs, minus the common words a
// question is mostly made of. It starts from the server's STOPWORDS
// (embeddings.ts) but strips MORE, and deliberately: the server's list feeds a
// weighted-coverage score where a missing term only lowers the total, while
// the search box runs an FTS AND where every surviving term must be on the
// page. So the question-framing verbs ("need", "want", "get", "use"…) that
// never appear on a subject's page are dropped too — otherwise "do I need a
// sick note?" would search for a page containing "need", and miss. A
// convenience, not a correctness surface; returns a space-joined string, or ''
// when nothing meaningful survives.
const SEARCH_STOPWORDS = new Set([
  'a','about','all','an','and','any','are','as','at','be','been','but','by','can','did','do','does',
  'for','from','get','got','give','has','have','how','i','if','in','is','it','its','make','made','may',
  'me','must','my','need','no','not','of','on','or','our','should','so','some','take','than','that','the',
  'their','them','then','there','these','they','this','to','us','use','want','was','we','were','what',
  'when','where','which','who','why','will','with','would','you','your',
]);
function searchTermsOf(question) {
  const terms = String(question ?? '')
    .toLowerCase()
    .match(/[a-z0-9]+/g);
  if (!terms) return '';
  return terms.filter((t) => t.length > 1 && !SEARCH_STOPWORDS.has(t)).join(' ');
}

function refusalHTML(result, question, collection) {
  const known = !result.reason || result.reason === 'no_canonical_match';
  // The pages that came closest, as PLACES TO LOOK. No quotation and no
  // snippet, deliberately: a quoted sentence under a refusal reads as the
  // answer the refusal just said does not exist. Four of four wrongful
  // refusals in the labelled set had the right page sitting top of the
  // candidates — what the asker lacked was its name, not a paraphrase of it.
  const nearest = Array.isArray(result.nearest) ? result.nearest.filter((n) => n && n.pageId && n.title) : [];
  const nearestHTML = !nearest.length ? '' : `
      <section class="refusal-nearest">
        <h3 class="h-small">The nearest pages in the record</h3>
        <p class="muted">Shown as places to look — the record has not answered, and these are
          not being quoted at you.</p>
        <ul class="nearest-list">
          ${nearest.map((n) => `
            <li><a href="#/pages/${esc(n.pageId)}">${esc(n.title)}</a>
              ${citationBadge(n)}</li>`).join('')}
        </ul>
      </section>`;
  return `
    <section class="refusal">
      <h2>The record does not answer this yet.</h2>
      <p>Nothing Canonical${collection ? ` in <strong>${esc(collection.name)}</strong>` : ''}
        covers ${question ? `&ldquo;${esc(question)}&rdquo;` : 'this question'}. Canon says so rather
        than assembling an answer it cannot cite — a confident guess is the one thing a
        knowledge record must never produce.</p>
      ${nearestHTML}
      ${known ? '' : `<p class="muted">Reported reason: <code>${esc(result.reason)}</code></p>`}
      <p class="refusal-why">Answers are drawn only from ${badge('canonical', 'sm')} pages you are
        permitted to see. If someone has written this up in a Draft, a Note, or a page still in
        review, it is deliberately not used here — it becomes answerable the moment it is
        reviewed to Canonical.</p>
      <h3 class="h-small refusal-next">What you can do</h3>
      <div class="refusal-actions">
        ${state.features.search === true ? '<button class="btn" type="button" id="refusal-search">Search the record instead</button>' : ''}
        ${collection
          ? '<button class="btn primary" type="button" id="refusal-draft">Draft a page in this collection</button>'
          : '<a class="btn primary" href="#/">Pick a collection and draft a page</a>'}
        <button class="btn subtle" type="button" id="refusal-rephrase">Ask it another way</button>
      </div>
    </section>`;
}

function askProblemHTML(err) {
  return `
    <section class="ask-problem">
      <h2 class="h-small">The question could not be put to the record</h2>
      <p>${esc(err?.message ?? 'Something went wrong.')}</p>
      <p><button class="btn" type="button" id="ask-retry">Try again</button></p>
    </section>`;
}

function askUnavailableHTML() {
  return `
    <div class="empty-state">
      <h2>Grounded answers are not available yet</h2>
      <p>This Canon server does not serve <code>/ask</code>. Search still covers the whole
        published record.</p>
      <p><a class="btn" href="#/">Back to collections</a></p>
    </div>`;
}

async function viewAsk(collectionId = null) {
  if (!(await detectAsk())) {
    app.innerHTML = `<div class="ask-wrap">${askUnavailableHTML()}</div>`;
    return;
  }
  const collection = collectionId ? await api('GET', `/collections/${collectionId}`) : null;
  let collections = [];
  try { collections = await api('GET', '/collections'); } catch { /* scope picker is optional */ }

  const cached = state.ask && state.ask.collectionId === collectionId ? state.ask : null;

  app.innerHTML = `
    <div class="ask-wrap">
      ${collection ? `<p class="breadcrumb"><a href="#/collections/${esc(collection.id)}">← ${esc(collection.name)}</a></p>` : ''}
      <div class="ask-head">
        <h1>Ask the record</h1>
        <p class="ask-lede">A plain-language question, answered only from Canonical pages you are
          permitted to see, with a citation for every claim. When the record is silent, Canon
          says so instead of guessing.</p>
      </div>

      <form class="ask-form" id="ask-form">
        <textarea id="ask-question" class="ask-question" rows="2" maxlength="500"
          aria-label="Your question"
          placeholder="${esc(ASK_EXAMPLES[0])}">${esc(cached?.question ?? '')}</textarea>
        <div class="ask-form-foot">
          <p class="ask-grounding">Grounded in ${badge('canonical', 'sm')} pages only${collection ? `, within <strong>${esc(collection.name)}</strong>` : ''} —
            including any now ${badge('needs_update', 'sm')}, which are still the record's own answer and are
            marked as such wherever they are cited. Drafts, Notes, and pages in review are never used.</p>
          <button class="btn primary" type="submit" id="ask-submit">Ask</button>
        </div>
        ${/* The rule about question text — readable by the asker and by
              operators — was stated honestly everywhere except to the person
              it most concerns: the one typing (fourth round, Ada and Tomas).
              One quiet line, under the grounding sentence, in the product's
              voice. */ ''}
        <p class="ask-grounding ask-kept">Questions are kept in the audit log, readable by you and by
          this record's operators.</p>
      </form>

      <div class="ask-scope">
        <label class="ask-scope-label" for="ask-scope-select">Answer from</label>
        <select id="ask-scope-select">
          <option value="" ${collection ? '' : 'selected'}>Every collection I can see</option>
          ${collections.map((c) => `<option value="${esc(c.id)}" ${c.id === collectionId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select>
        ${collection ? `<span class="muted">Only ${esc(collection.name)}'s Canonical pages can be cited.</span>` : ''}
      </div>

      <div class="ask-result" id="ask-result" aria-live="polite"></div>
    </div>`;

  const form = app.querySelector('#ask-form');
  const input = app.querySelector('#ask-question');
  const submit = app.querySelector('#ask-submit');
  const resultHost = app.querySelector('#ask-result');

  const idleHTML = `
    <div class="ask-idle">
      <p class="h-small">Try something like</p>
      <ul class="ask-examples">
        ${ASK_EXAMPLES.map((q) => `<li><button type="button" class="ask-example" data-q="${esc(q)}">${esc(q)}</button></li>`).join('')}
      </ul>
      <p class="muted ask-idle-foot">Answers arrive with their sources attached, so you can read
        the page behind every sentence.</p>
    </div>`;

  const wireResult = (question) => {
    resultHost.querySelectorAll('[data-cite]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = resultHost.querySelector(`[data-citation="${btn.dataset.cite}"]`);
        if (!target) return;
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.add('flash');
        setTimeout(() => target.classList.remove('flash'), 1400);
      });
    });
    resultHost.querySelector('#refusal-rephrase')?.addEventListener('click', () => {
      input.focus();
      input.select();
    });
    resultHost.querySelector('#refusal-search')?.addEventListener('click', () => {
      const box = document.getElementById('search-input');
      if (!box) return;
      // Hand search the QUESTION'S TERMS, not the question. The search box runs
      // an FTS MATCH that ANDs every token, so pre-filling "do I need a sick
      // note?" verbatim required a page containing "do", "a", and the literal
      // "note?" — a guaranteed second dead end after the refusal (fifth round,
      // Ada). Stripped to "sick note", it finds the page the alias carries.
      // If nothing meaningful survives the strip, the box is left empty and
      // focused rather than pre-filled with junk.
      const terms = searchTermsOf(question);
      box.value = terms;
      box.dispatchEvent(new Event('input'));
      box.focus();
      if (!terms) box.select();
    });
    resultHost.querySelector('#refusal-draft')?.addEventListener('click', async () => {
      try {
        const tree = await api('GET', `/collections/${collection.id}/tree`);
        openNewPageModal(collection, tree);
      } catch (err) { toastError(err); }
    });
    resultHost.querySelector('#ask-retry')?.addEventListener('click', () => ask(question));
  };

  const renderResult = (result, question) => {
    const citations = (Array.isArray(result?.citations) ? result.citations : []).map(normalizeCitation);
    // An answer without citations is never returned (DATA-BACKBONE §5), so an
    // empty-handed non-refusal is treated as the refusal it effectively is.
    if (result?.refused || !result?.answer || !citations.length) {
      resultHost.innerHTML = refusalHTML(result ?? {}, question, collection);
    } else {
      // §7: the record answering twice, differently, is a correct answer and
      // is drawn as one. Absent from the payload, absent from the screen.
      resultHost.innerHTML = answerHTML(result.answer, citations, normalizeDisagreement(result.disagreement, citations));
    }
    wireResult(question);
  };

  const ask = async (question) => {
    resultHost.setAttribute('aria-busy', 'true');
    resultHost.innerHTML = askSkeletonHTML();
    submit.disabled = true;
    submit.textContent = 'Reading…';
    try {
      const payload = { question };
      if (collectionId) payload.collectionId = collectionId;
      const result = await api('POST', '/ask', payload);
      state.ask = { question, collectionId, result };
      renderResult(result, question);
    } catch (err) {
      if (err.status === 404 || err.status === 405) {
        state.features.ask = false;
        const link = document.getElementById('nav-ask');
        if (link) link.hidden = true;
        resultHost.innerHTML = askUnavailableHTML();
      } else {
        resultHost.innerHTML = askProblemHTML(err);
        wireResult(question);
      }
    } finally {
      resultHost.removeAttribute('aria-busy');
      submit.disabled = false;
      submit.textContent = 'Ask';
    }
  };

  if (cached?.result) renderResult(cached.result, cached.question);
  else {
    resultHost.innerHTML = idleHTML;
    resultHost.querySelectorAll('.ask-example').forEach((btn) => {
      btn.addEventListener('click', () => { input.value = btn.dataset.q; ask(btn.dataset.q); });
    });
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const question = input.value.trim();
    if (!question) { input.focus(); return; }
    ask(question);
  });
  // Enter asks; Shift+Enter is a newline, as in any question box.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });
  app.querySelector('#ask-scope-select').addEventListener('change', (e) => {
    location.hash = e.target.value ? `#/ask/${e.target.value}` : '#/ask';
  });
  input.focus();
}

// ---------------------------------------------------------------------------
// Knowledge map
//
// Two contracts, one screen.
//
//   GET /collections/:id/graph  — one collection.
//     -> { collectionId, generatedAt, counts, truncated,
//          nodes: [ { id, kind: 'page', title, type, status, collectionId,
//                     parentId, external, provenance, origin, references, version }
//                 | { id, kind: 'source', name, type, status: null, authMode,
//                     freshnessWindowMs, provenance, references } ],
//          edges: [ { from, to,
//                     kind: 'child' | 'link' | 'reference'
//                         | 'conflicts_with' | 'supersedes' } ] }
//
//   GET /graph — the whole record this asker may see. Feature-detected the way
//     /ask and /sources are: where the server does not serve it, the
//     whole-record entry is simply not there.
//     -> { collections: [ { id, name } ],
//          nodes: [ { id, kind, title, collectionId, type, status, provenance,
//                     importSource?, importFile?, degree, rootId } ],
//          edges: [ ... ],
//          truncated?: { limit, total } }
//
// Two questions, one screen. HOW IS THIS KNOWLEDGE RELATED — and the edges are
// only ever the explicit graph Canon maintains: the tree, the links people
// wrote in published bodies, the reference fields pages carry, and the
// conflicts and supersessions people ASSERTED between pages (DATA-BACKBONE.md
// §7). That last pair is why contradiction is something you can see on this
// screen rather than something found during an audit — and it is drawn for
// exactly the same reason as the other three: a person wrote it down, with a
// note saying how the two pages disagree. Canon surfaces the contradiction and
// never resolves it. Nothing here
// draws a similarity edge, and nothing here infers a cluster from one: the
// communities the picture shows are the tree roots and collections the record
// already has, which is why they can be named in a legend rather than
// described as "topics" (DATA-BACKBONE.md §5). WHERE DOES ITS MATERIAL COME
// FROM — authored here, imported from another system, or federated from a
// source that still owns the fact (§6). Status is on every node, because
// standing is what separates the record from notes.
//
// TWO LAYOUTS, BOTH DETERMINISTIC
//
//   Constellation — a seeded force-directed layout, clustered by tree root and
//     by collection. This is the default for the whole record and for anything
//     with more than one root, because that shape is a web and drawing a web as
//     columns flattens exactly the thing worth seeing: which pages everything
//     hangs off, and which parts of the record barely touch each other.
//   Tree — the tidy layered layout, one column per depth. This stays the
//     default for a single collection with a single root, because a small tree
//     genuinely reads better as a tree: the parent relation is the whole
//     structure, and a column layout states it without the reader having to
//     trace an edge. Both are always one click apart.
//
// The physics is run to a FIXED iteration count before the first paint and
// never animated frame by frame, and every random draw comes from a PRNG seeded
// off the node's own id (see mulberry32 below) — never Math.random(), and never
// a sequential stream whose values would depend on iteration order. Reload the
// page and the same record lands in the same place, pixel for pixel. What is
// animated is the REVEAL, not the settling: the layout is already final when
// the first node fades in.
//
// And a picture nobody can read is worse than a list, so the same data renders
// as a nested list on demand, and by default past MAP_LABELLED_CAP nodes.

// --- tree layout geometry ---
const MAP_NODE_W = 178;
const MAP_NODE_H = 48;
const MAP_COL_GAP = 86;
const MAP_ROW_GAP = 16;
const MAP_ROOT_GAP = 28;
const MAP_PAD = 28;

const MAP_ZOOM_MIN = 0.18;
const MAP_ZOOM_MAX = 3.2;
// The zoom below which a TREE node's label is no longer readable. Fit never
// starts below it; a reader may still zoom out past it deliberately. The
// constellation has no such floor, because its labels are tiered — zoomed out
// it shows the hubs' names and the shape, which is a true reading of it.
const MAP_ZOOM_READABLE = 0.55;
// The size past which the O(n²) charge sum stops being the cheaper answer. It
// is not a legibility threshold — that is MAP_LABELLED_CAP below, and it is a
// long way under this — it is the number the force layout's own comments mean.
const MAP_GRAPH_CAP = 600;
// WHAT OPENS BY DEFAULT, and why it is not the drawing on a real record.
//
// The constellation labels its nodes in tiers — the hubs at every zoom, and
// another band with each step in — which is a true reading of a big graph and
// is the wrong first thing to hand somebody. A new contributor opened the map
// on the demo corpus and got 244 dots, of which about forty were named, and no
// colour key anywhere on the screen (USER-TESTING.md T4.6). She then found the
// list view, two clicks away, and called it genuinely excellent.
//
// So the rule is now the honest one: a DRAWING is the default only while it
// can name every node on it. Past that the list opens — the same data, every
// title written out, every relation spelled — and the picture is one click
// away with a key drawn on top of it. Below the threshold nothing changes: a
// forty-node collection is a picture worth opening on.
//
// The number is the point at which the tiers start hiding names: `lt-2` and
// `lt-3` are the bands below roughly 19% of the nodes, so past ~120 nodes an
// unzoomed constellation is mostly anonymous.
const MAP_LABELLED_CAP = 120;

// --- constellation geometry and physics ---
const MAP_R_MIN = 5.5; // a page nothing hangs off
const MAP_R_K = 3.7; // × √degree — compressive, so one huge hub cannot dominate
const MAP_R_MAX = 26;
const MAP_FORCE_PAD = 56;
// A child sits close to its parent; a link across the record is long and weak,
// because it is a relation between two communities rather than inside one — let
// it pull hard and every community dissolves into one grey ball.
// A relation sits between the two: closer than a link, because two pages that
// contradict each other are usually about the same thing, and weaker than the
// tree, because it must never pull a page out of its own branch.
const MAP_LINK_GAP = { child: 13, link: 88, reference: 38, conflicts_with: 64, supersedes: 54 };
const MAP_LINK_STRENGTH = { child: 1, link: 0.2, reference: 0.5, conflicts_with: 0.3, supersedes: 0.35 };
const MAP_CLUSTER_PULL = 0.19;
const MAP_GRAVITY = 0.012;
const MAP_VELOCITY_KEEP = 0.62;
const MAP_COLLIDE_PAD = 3;

// Hues for cluster identity. Deliberately not a rainbow of primaries: one arc
// through the neutrals either side of Canon's own accent (a 163° green), every
// one of them used at the low saturation and mid lightness the rest of the UI
// keeps to, so a map of forty clusters still looks like this product. The
// accent's own hue comes first, so a single-collection map is drawn in Canon's
// colour rather than an arbitrary one.
const MAP_HUES = [163, 199, 221, 252, 288, 331, 14, 36, 74, 128];

const MAP_LABEL_TIERS = 4; // 0 = hubs, always drawn; 3 = only at full zoom

const PROVENANCE_LABELS = {
  authored: 'Authored in Canon',
  imported: 'Imported',
  federated: 'Federated',
};
const PROVENANCE_HELP = {
  authored: 'Written here, by a person or an agent. Canon is the record.',
  imported: 'Migrated in from another system. Canon is the record now — and the system it came from should have been retired, so this set is worth keeping short.',
  federated: 'Depends on a system that still owns the fact. Canon holds the reference and resolves the value when the page is read; it never copies it.',
};
const EDGE_LABELS = {
  child: 'Tree',
  link: 'Link',
  reference: 'Source',
  // DATA-BACKBONE.md §7. Explicit relations between pages, asserted by a
  // person — which is the only reason they may be drawn.
  conflicts_with: 'Conflicts with',
  supersedes: 'Supersedes',
};
const EDGE_HELP = {
  child: 'Parent to child: where the page sits in the tree.',
  link: 'A link one published page makes to another. Written by hand, never inferred.',
  reference: 'A reference field on a page, resolving against a registered external source.',
  // Both say what the map DRAWS, not what the record holds: an edge whose far
  // end sits in a collection you are not a member of is not drawn, so a count
  // of nought here is not a claim that the record holds none.
  conflicts_with: 'A person asserted that these two pages contradict each other, and said how. Canon surfaces the contradiction; it never resolves it — no merge, no precedence, no quiet winner. Only relations whose other page you can also read are drawn here; the panel on each page lists the rest, without naming what is at the far end.',
  supersedes: 'A person asserted that one page replaces another. The superseded page keeps its standing and its history: saying so archives nothing. Only relations whose other page you can also read are drawn here; the panel on each page lists the rest, without naming what is at the far end.',
};
// The order the legend and the edge filters use. The two relations come last
// because they are the newest thing on the map, not because they matter least.
const MAP_EDGE_KINDS = ['child', 'link', 'reference', 'conflicts_with', 'supersedes'];
// Which edges carry an arrowhead. A tree edge does not, because the parent is
// the node its children hang off; a CONFLICT does not, because it is symmetric
// — "A conflicts with B" is the same statement as "B conflicts with A", and an
// arrow would assert a direction the record does not hold. The server stores
// such a relation once, with its ends in a fixed order, so which way round it
// arrives is an implementation detail the picture must not repeat.
const MAP_EDGE_ARROW = { link: true, reference: true, supersedes: true };

// ---- deterministic pseudo-randomness ---------------------------------------
//
// mulberry32, seeded per node off a hash of its id. Two properties matter and
// both are load-bearing: the stream is reproducible, so the same record settles
// into the same picture on every reload; and because each node draws from its
// OWN seed rather than from one shared sequence, the picture does not change
// when the payload's order does. Math.random() appears nowhere in this file.

function mapHash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- feature detection -----------------------------------------------------
//
// The per-collection map is detected exactly as /ask and /sources are — with
// one wrinkle: it lives under a collection, and `GET /collections/<unknown>/graph`
// answers 404 whether the ROUTE is missing or the COLLECTION is. Only a
// collection this actor really has tells the two apart, so the probe asks for
// one first. No collections at all means nothing to map and nothing to
// conclude, so that answer is not cached.
let mapProbe = null;

async function probeMapEndpoint() {
  let collections;
  try {
    const r = await api('GET', '/collections');
    collections = Array.isArray(r) ? r : (r?.collections ?? []);
  } catch {
    return null; // cannot tell; ask again later
  }
  const first = collections[0];
  if (!first?.id) return null;
  try {
    await api('GET', `/collections/${encodeURIComponent(first.id)}/graph`);
    return true;
  } catch (err) {
    if (err.status === 0) return null;
    return err.status !== 404 && err.status !== 405;
  }
}

async function detectMap() {
  if (state.features.map !== true && state.features.map !== false) {
    mapProbe ??= probeMapEndpoint();
    const found = await mapProbe;
    mapProbe = null;
    if (found !== null && state.features.map !== true && state.features.map !== false) {
      state.features.map = found;
    }
  }
  const link = document.getElementById('nav-map');
  if (link) link.hidden = state.features.map !== true;
  return state.features.map === true;
}

// The whole record — every collection the asker may see — is a separate
// endpoint and therefore a separate probe. It is deliberately NOT probed from
// the chrome: the answer is the whole graph, and downloading it on every page
// load to decide whether to show a nav entry would be a rude way to learn one
// boolean. It is asked for the first time the map view needs it, and the
// payload that answered the probe is the payload the view draws, so the cost is
// one request either way. Where it 404s, the whole-record entry is absent —
// never greyed out, never a link that explains itself with an error.
let wholeGraphProbe = null;
let wholeGraphCache = null; // { at, raw } — reused only by the render that probed

async function detectWholeGraph() {
  if (state.features.wholeGraph === true || state.features.wholeGraph === false) {
    return state.features.wholeGraph;
  }
  wholeGraphProbe ??= api('GET', '/graph')
    .then((raw) => {
      wholeGraphCache = { at: Date.now(), raw };
      return true;
    })
    .catch((err) => (err.status === 404 || err.status === 405 ? false : err.status === 0 ? null : true));
  const found = await wholeGraphProbe;
  wholeGraphProbe = null;
  if (found !== null) state.features.wholeGraph = found;
  return found === true;
}

async function fetchWholeGraph() {
  if (wholeGraphCache && Date.now() - wholeGraphCache.at < 15000) {
    const { raw } = wholeGraphCache;
    wholeGraphCache = null;
    return raw;
  }
  wholeGraphCache = null;
  return api('GET', '/graph');
}

// The collection view's entry to the map: simply not there when the endpoint
// is not, like every other detected affordance.
async function renderMapAffordance(hostId, collectionId) {
  const host = document.getElementById(hostId);
  if (!host || !(await detectMap())) return;
  if (!host.isConnected) return;
  host.innerHTML = `<a class="btn subtle" href="#/collections/${esc(collectionId)}/map"
    title="See how this collection hangs together, and where its material comes from">Knowledge map</a>`;
}

// ---- payload normalisation -------------------------------------------------
//
// One normaliser for both contracts. The whole-record payload names an import
// with two flat fields where the per-collection one nests an origin object, and
// carries `degree` and `rootId` the per-collection one leaves to the client;
// everything downstream sees a single shape.

function normalizeGraphNode(n) {
  const kind = n?.kind === 'source' ? 'source' : 'page';
  const provenance = PROVENANCE_LABELS[n?.provenance] ? n.provenance : kind === 'source' ? 'federated' : 'authored';
  // Provenance precedence loses the IMPORTED label for a page that also reads
  // from a live source, but never loses where it came from: origin is read
  // whatever the label says, so a federated page still names its migration.
  const origin = n?.origin && n.origin.system
    ? { system: n.origin.system, file: n.origin.file ?? '', runId: n.origin.runId ?? null, at: n.origin.at ?? null }
    : n?.importSource
      ? { system: n.importSource, file: n.importFile ?? '', runId: null, at: null }
      : null;
  return {
    id: String(n?.id ?? ''),
    kind,
    title: String((kind === 'source' ? (n?.name ?? n?.title) : (n?.title ?? n?.name)) ?? '(untitled)'),
    type: n?.type ?? null,
    status: kind === 'page' ? (n?.status ?? 'draft') : null,
    collectionId: n?.collectionId ?? null,
    parentId: n?.parentId ?? null,
    external: n?.external === true,
    provenance,
    origin,
    references: Number(n?.references ?? 0) || 0,
    version: n?.version ?? null,
    authMode: n?.authMode ?? null,
    freshnessWindowMs: n?.freshnessWindowMs ?? null,
    // The server's own view of how connected a node is, where it offers one.
    // Sizing uses the VISIBLE degree instead (see mapAnnotate) so a filtered
    // map never draws a hub whose edges are not on the screen.
    payloadDegree: Number.isFinite(Number(n?.degree)) ? Number(n.degree) : null,
    rootId: n?.rootId ? String(n.rootId) : null,
  };
}

// `truncated` is a boolean in the per-collection payload and an object in the
// whole-record one. Both mean the same thing and both are stated; only the
// second can say by how much.
function normalizeTruncated(t) {
  if (t && typeof t === 'object') {
    const limit = Number(t.limit);
    const total = Number(t.total);
    return { limit: Number.isFinite(limit) ? limit : null, total: Number.isFinite(total) ? total : null };
  }
  return t === true ? {} : null;
}

function normalizeGraph(g) {
  const nodes = (Array.isArray(g?.nodes) ? g.nodes : []).map(normalizeGraphNode).filter((n) => n.id);
  const known = new Set(nodes.map((n) => n.id));
  const edges = (Array.isArray(g?.edges) ? g.edges : [])
    .map((e) => ({ from: String(e?.from ?? ''), to: String(e?.to ?? ''), kind: e?.kind }))
    // An edge to something that is not on the map is dropped rather than drawn
    // to a placeholder — the server already does this, and the client does not
    // undo it. A box saying "something you may not see, here" is a disclosure.
    .filter((e) => EDGE_LABELS[e.kind] && known.has(e.from) && known.has(e.to));
  const collections = (Array.isArray(g?.collections) ? g.collections : [])
    .map((c) => ({ id: String(c?.id ?? ''), name: String(c?.name ?? c?.id ?? '') }))
    .filter((c) => c.id);
  return {
    collectionId: g?.collectionId ?? null,
    generatedAt: g?.generatedAt ?? null,
    truncated: normalizeTruncated(g?.truncated),
    counts: g?.counts ?? {},
    collections,
    nodes,
    edges,
  };
}

// ---- filtering -------------------------------------------------------------

// "Show me only what's federated" and "show me what's past review" are one
// click each, and the graph and the list are both drawn from THIS — so they
// can never disagree about what is on the map.
function mapVisible(graph, filters) {
  const provOk = (n) =>
    filters.provenance.has(n.provenance) ||
    // A page that was imported AND carries a live reference reads as federated,
    // so "imported" would otherwise hide part of the migration's own trail.
    (filters.provenance.has('imported') && !!n.origin);
  const collOk = (n) => !filters.collections || !n.collectionId || filters.collections.has(n.collectionId);
  const pages = graph.nodes.filter(
    (n) => n.kind === 'page' && provOk(n) && filters.status.has(n.status) && collOk(n),
  );
  const visible = new Map(pages.map((n) => [n.id, n]));

  // A source is on the map because pages depend on it: it appears when at
  // least one visible page still reaches it by a visible edge.
  const sourceById = new Map(graph.nodes.filter((n) => n.kind === 'source').map((n) => [n.id, n]));
  const sources = new Map();
  const edges = [];
  for (const e of graph.edges) {
    if (!filters.edges.has(e.kind)) continue;
    if (e.kind === 'reference') {
      const page = visible.get(e.from);
      const source = sourceById.get(e.to);
      if (!page || !source || !filters.provenance.has('federated')) continue;
      sources.set(source.id, source);
      edges.push(e);
      continue;
    }
    if (!visible.has(e.from) || !visible.has(e.to)) continue;
    edges.push(e);
  }
  const nodes = [...pages, ...sources.values()];
  return mapAnnotate({ nodes, edges, byId: new Map(nodes.map((n) => [n.id, n])) });
}

// Everything the drawing and the list both need, derived once from what is
// actually visible: how connected each node is, which community it belongs to,
// and who its neighbours are.
//
// A node's CLUSTER is the tree root it hangs from — the server's `rootId` where
// it gives one, otherwise the root of the visible parent chain. Its GROUP is
// its collection. Neither is inferred: both are structures a person made, which
// is the only reason a map that draws communities is allowed to exist here.
function mapAnnotate(visible) {
  const { nodes, edges } = visible;
  const parentOf = new Map();
  const neighbors = new Map();
  const degree = new Map();
  for (const n of nodes) {
    neighbors.set(n.id, new Set());
    degree.set(n.id, 0);
  }
  for (const e of edges) {
    if (e.kind === 'child' && !parentOf.has(e.to)) parentOf.set(e.to, e.from);
    neighbors.get(e.from)?.add(e.to);
    neighbors.get(e.to)?.add(e.from);
  }
  for (const [id, near] of neighbors) degree.set(id, near.size);

  const rootOf = new Map();
  const resolveRoot = (id) => {
    if (rootOf.has(id)) return rootOf.get(id);
    let cur = id;
    const seen = new Set([id]);
    for (let i = 0; i < 64; i += 1) {
      const p = parentOf.get(cur);
      if (!p || seen.has(p)) break;
      seen.add(p);
      cur = p;
    }
    for (const seenId of seen) rootOf.set(seenId, cur);
    return cur;
  };

  const cluster = new Map();
  const group = new Map();
  for (const n of nodes) {
    if (n.kind === 'source') {
      // A source belongs to no tree and to no collection — the server sends
      // `collectionId: null`, and a `rootId` that is the source's own id so
      // that clustering by root does not drop it. Here it is given no community
      // at all on purpose: a singleton cluster would be shoved around by the
      // cluster-separation force, whereas a source with no community is pulled
      // only by the pages that read it, and settles beside them. Nothing
      // downstream may assume a source has a collection or a status.
      cluster.set(n.id, null);
      group.set(n.id, null);
      continue;
    }
    const root = n.rootId || resolveRoot(n.id);
    cluster.set(n.id, root);
    group.set(n.id, n.collectionId || root);
  }
  return { ...visible, parentOf, neighbors, degree, cluster, group };
}

// ---- palette ----------------------------------------------------------------
//
// Colour carries three things at once, on three channels that cannot be
// confused for one another:
//
//   HUE          which community — the collection, or the tree root when there
//                is only one collection on the map.
//   LIGHTNESS    which tree root inside that collection, in three steps. Close
//                enough to read as one family, far enough to separate branches.
//   RING / STROKE provenance and standing, which are never hues, so they stay
//                legible whatever community a node is in. A Needs Update page
//                wears an amber ring, and it is the only amber ring on the map.
//
// The actual saturations and lightnesses live in CSS so the whole palette
// re-renders in dark mode without a line of JavaScript: the gradient carries a
// --h custom property, and the stops resolve it against theme-aware variables.

function mapPalette(visible, scope) {
  const groups = [...new Set([...visible.group.values()].filter(Boolean))].sort();
  // One collection on the map means the collection is not the interesting
  // division; the tree roots are, so they take the hues instead.
  const byRoot = scope !== 'all' || groups.length <= 1;
  const keyOf = byRoot
    ? (id) => visible.cluster.get(id)
    : (id) => visible.group.get(id);
  const keys = [...new Set(visible.nodes.map((n) => keyOf(n.id)).filter(Boolean))].sort();
  const hueIndex = new Map(keys.map((k, i) => [k, i]));

  // Inside a collection, each tree root takes one of three lightness steps.
  const shadeIndex = new Map();
  if (!byRoot) {
    const perGroup = new Map();
    for (const key of [...new Set(visible.nodes.map((n) => visible.cluster.get(n.id)).filter(Boolean))].sort()) {
      const owner = visible.nodes.find((n) => visible.cluster.get(n.id) === key);
      const g = owner ? visible.group.get(owner.id) : null;
      const seen = perGroup.get(g) ?? 0;
      perGroup.set(g, seen + 1);
      shadeIndex.set(key, seen % 3);
    }
  }

  const hueOf = (index) =>
    (MAP_HUES[index % MAP_HUES.length] + Math.floor(index / MAP_HUES.length) * 13) % 360;
  const swatch = new Map(); // node id -> { hue, shade, key }
  for (const n of visible.nodes) {
    if (n.kind === 'source') continue;
    const key = keyOf(n.id);
    const index = hueIndex.get(key) ?? 0;
    const shade = byRoot ? 1 : (shadeIndex.get(visible.cluster.get(n.id)) ?? 1);
    swatch.set(n.id, { hue: hueOf(index), shade, key });
  }
  const gradients = new Map(); // "hue-shade" -> { id, hue, shade }
  for (const s of swatch.values()) {
    const key = `${s.hue}-${s.shade}`;
    if (!gradients.has(key)) gradients.set(key, { id: `mg-${key}`, hue: s.hue, shade: s.shade });
  }
  return { byRoot, swatch, gradients, keys, hueOf, hueIndex };
}

// ---- the constellation: a seeded force layout ------------------------------
//
// Velocity Verlet, run to a fixed iteration count and then stopped. Four forces:
//
//   LINK      every explicit edge is a spring, at a rest length that says what
//             kind of edge it is — a child sits close to its parent, a link
//             reaches further, a source further still. Its stiffness falls with
//             the degree of the sparser endpoint, which is what stops a hub from
//             dragging its whole neighbourhood into a knot.
//   CHARGE    every node repels every other, harder the bigger it is. O(n²), and
//             deliberately so: at the sizes this map draws (MAP_GRAPH_CAP, and
//             the list is already the default well under it) a Barnes–Hut tree
//             costs more to build than the
//             pairs cost to walk, and an exact sum is one less approximation to
//             explain.
//   CLUSTER   each node is pulled to its community's centre, and the centres
//             push each other apart. This is where the communities come from —
//             and they are the record's own tree roots and collections, not
//             anything this file inferred.
//   GRAVITY   a weak pull to the origin so nothing drifts off the canvas.
//
// Collisions are resolved positionally each step, and again in a few relaxation
// passes at the end, so no two nodes overlap in the picture that is finally
// drawn.

function mapForceIterations(n) {
  // A function of n alone, so it is as deterministic as everything else here.
  if (n <= 60) return 460;
  if (n <= 150) return 400;
  if (n <= 400) return 300;
  return 230;
}

function mapNodeRadius(deg, kind) {
  const r = MAP_R_MIN + MAP_R_K * Math.sqrt(Math.max(0, deg));
  // A source is an object rather than a page, and it is drawn as one, so it
  // gets a floor that keeps its square readable at any degree.
  return Math.min(MAP_R_MAX, kind === 'source' ? Math.max(r, 9) : r);
}

function mapForceLayout(visible) {
  const t0 = performance.now();
  const nodes = visible.nodes;
  const n = nodes.length;
  const index = new Map(nodes.map((node, i) => [node.id, i]));

  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const vx = new Float64Array(n);
  const vy = new Float64Array(n);
  const rad = new Float64Array(n);
  const charge = new Float64Array(n);
  const deg = new Int32Array(n);
  const clusterOf = new Int32Array(n).fill(-1);

  // Communities, ordered by key so the numbering is stable across reloads.
  const clusterKeys = [...new Set(nodes.map((node) => visible.cluster.get(node.id)).filter(Boolean))].sort();
  const clusterIndex = new Map(clusterKeys.map((k, i) => [k, i]));
  const groupKeys = [...new Set(nodes.map((node) => visible.group.get(node.id)).filter(Boolean))].sort();
  const groupIndex = new Map(groupKeys.map((k, i) => [k, i]));
  const cCount = clusterKeys.length;
  const clusterGroup = new Int32Array(Math.max(1, cCount)).fill(-1);
  const clusterSize = new Int32Array(Math.max(1, cCount));

  let area = 0;
  for (let i = 0; i < n; i += 1) {
    const node = nodes[i];
    const d = visible.degree.get(node.id) ?? 0;
    deg[i] = d;
    rad[i] = mapNodeRadius(d, node.kind);
    charge[i] = -(12 + rad[i] * rad[i] * 0.72);
    area += (rad[i] + 11) * (rad[i] + 11) * Math.PI;
    const ck = visible.cluster.get(node.id);
    if (ck && clusterIndex.has(ck)) {
      const ci = clusterIndex.get(ck);
      clusterOf[i] = ci;
      clusterSize[ci] += 1;
      const gk = visible.group.get(node.id);
      if (gk && groupIndex.has(gk)) clusterGroup[ci] = groupIndex.get(gk);
    }
  }
  // How big the finished picture wants to be, from how much ink is in it.
  const span = Math.sqrt(area / Math.PI) * 2.15;

  // Cluster anchors: groups on a golden-angle spiral, and each group's tree
  // roots on a smaller spiral of their own around it. This is the seed the
  // physics starts from, not the answer it gives.
  const gx = new Float64Array(Math.max(1, groupKeys.length));
  const gy = new Float64Array(Math.max(1, groupKeys.length));
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < groupKeys.length; i += 1) {
    const a = i * GOLDEN;
    const rr = groupKeys.length === 1 ? 0 : span * 0.62 * Math.sqrt((i + 0.5) / groupKeys.length);
    gx[i] = Math.cos(a) * rr * 1.4;
    gy[i] = Math.sin(a) * rr * 0.8;
  }
  const cx = new Float64Array(Math.max(1, cCount));
  const cy = new Float64Array(Math.max(1, cCount));
  const cRad = new Float64Array(Math.max(1, cCount));
  const perGroupSeen = new Int32Array(Math.max(1, groupKeys.length));
  const perGroupTotal = new Int32Array(Math.max(1, groupKeys.length));
  for (let ci = 0; ci < cCount; ci += 1) {
    const g = clusterGroup[ci];
    if (g >= 0) perGroupTotal[g] += 1;
  }
  for (let ci = 0; ci < cCount; ci += 1) {
    const g = clusterGroup[ci];
    const rng = mulberry32(mapHash32(`cluster:${clusterKeys[ci]}`));
    const seat = g >= 0 ? perGroupSeen[g]++ : ci;
    const total = g >= 0 ? Math.max(1, perGroupTotal[g]) : Math.max(1, cCount);
    const a = seat * GOLDEN + rng() * 0.4;
    const local = span * (groupKeys.length > 1 ? 0.3 : 0.72) * Math.sqrt((seat + 0.5) / total);
    cx[ci] = (g >= 0 ? gx[g] : 0) + Math.cos(a) * local;
    cy[ci] = (g >= 0 ? gy[g] : 0) + Math.sin(a) * local;
    cRad[ci] = Math.sqrt(Math.max(1, clusterSize[ci])) * 13 + 13;
  }

  // Initial positions: each node near its community's seat, offset by a draw
  // from a PRNG seeded off its own id.
  for (let i = 0; i < n; i += 1) {
    const rng = mulberry32(mapHash32(nodes[i].id));
    const ci = clusterOf[i];
    const spreadR = ci >= 0 ? cRad[ci] * 0.85 : span * 0.75;
    const a = rng() * Math.PI * 2;
    const rr = Math.sqrt(rng()) * spreadR;
    x[i] = (ci >= 0 ? cx[ci] : 0) + Math.cos(a) * rr;
    y[i] = (ci >= 0 ? cy[ci] : 0) + Math.sin(a) * rr;
  }

  // Springs, prepared once.
  const eFrom = new Int32Array(visible.edges.length);
  const eTo = new Int32Array(visible.edges.length);
  const eDist = new Float64Array(visible.edges.length);
  const eStr = new Float64Array(visible.edges.length);
  const eBias = new Float64Array(visible.edges.length);
  let eCount = 0;
  for (const e of visible.edges) {
    const a = index.get(e.from);
    const b = index.get(e.to);
    if (a === undefined || b === undefined || a === b) continue;
    eFrom[eCount] = a;
    eTo[eCount] = b;
    eDist[eCount] = rad[a] + rad[b] + (MAP_LINK_GAP[e.kind] ?? 40);
    const weakest = Math.max(1, Math.min(deg[a], deg[b]));
    eStr[eCount] = Math.min(1, 1 / weakest) * (MAP_LINK_STRENGTH[e.kind] ?? 0.7);
    eBias[eCount] = deg[a] / Math.max(1, deg[a] + deg[b]);
    eCount += 1;
  }

  const iterations = mapForceIterations(n);
  const alphaDecay = 1 - Math.pow(0.001, 1 / iterations);
  let alpha = 1;

  const sumX = new Float64Array(Math.max(1, cCount));
  const sumY = new Float64Array(Math.max(1, cCount));
  const sumN = new Int32Array(Math.max(1, cCount));
  const gSumX = new Float64Array(Math.max(1, groupKeys.length));
  const gSumY = new Float64Array(Math.max(1, groupKeys.length));
  const gSumN = new Int32Array(Math.max(1, groupKeys.length));

  for (let step = 0; step < iterations; step += 1) {
    alpha += (0 - alpha) * alphaDecay;

    // --- charge and collision, one pass over the pairs ---
    for (let i = 0; i < n; i += 1) {
      const xi = x[i];
      const yi = y[i];
      const qi = charge[i];
      const ri = rad[i];
      let ax = 0;
      let ay = 0;
      for (let j = i + 1; j < n; j += 1) {
        let dx = x[j] - xi;
        let dy = y[j] - yi;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1e-6) {
          // Two nodes exactly on top of each other have no direction to
          // separate along; take one from each node's own seeded stream.
          const rng = mulberry32(mapHash32(`${nodes[i].id}~${nodes[j].id}`));
          dx = (rng() - 0.5) * 0.01;
          dy = (rng() - 0.5) * 0.01;
          d2 = dx * dx + dy * dy;
        }
        const w = alpha / Math.max(d2, 36);
        ax += dx * charge[j] * w;
        ay += dy * charge[j] * w;
        vx[j] -= dx * qi * w;
        vy[j] -= dy * qi * w;
        const want = ri + rad[j] + MAP_COLLIDE_PAD;
        if (d2 < want * want) {
          const d = Math.sqrt(d2);
          const push = ((want - d) / d) * 0.35;
          const px = dx * push;
          const py = dy * push;
          x[j] += px;
          y[j] += py;
          x[i] -= px;
          y[i] -= py;
        }
      }
      vx[i] += ax;
      vy[i] += ay;
    }

    // --- links ---
    for (let k = 0; k < eCount; k += 1) {
      const a = eFrom[k];
      const b = eTo[k];
      const dx = x[b] + vx[b] - x[a] - vx[a];
      const dy = y[b] + vy[b] - y[a] - vy[a];
      const d = Math.sqrt(dx * dx + dy * dy) || 1e-3;
      const l = ((d - eDist[k]) / d) * alpha * eStr[k];
      const bias = eBias[k];
      vx[b] -= dx * l * bias;
      vy[b] -= dy * l * bias;
      vx[a] += dx * l * (1 - bias);
      vy[a] += dy * l * (1 - bias);
    }

    // --- communities: centres follow their members, and shove each other off ---
    if (cCount) {
      sumX.fill(0);
      sumY.fill(0);
      sumN.fill(0);
      for (let i = 0; i < n; i += 1) {
        const ci = clusterOf[i];
        if (ci < 0) continue;
        sumX[ci] += x[i];
        sumY[ci] += y[i];
        sumN[ci] += 1;
      }
      for (let ci = 0; ci < cCount; ci += 1) {
        if (!sumN[ci]) continue;
        cx[ci] += (sumX[ci] / sumN[ci] - cx[ci]) * 0.16;
        cy[ci] += (sumY[ci] / sumN[ci] - cy[ci]) * 0.16;
      }
      // Two levels of community, because the record has two: a page's tree root
      // inside its collection, and the collection itself. Without this second
      // pull the roots of one collection drift apart under the cross-record
      // links and the colours stop meaning a place on the map.
      if (groupKeys.length > 1) {
        gSumX.fill(0);
        gSumY.fill(0);
        gSumN.fill(0);
        for (let ci = 0; ci < cCount; ci += 1) {
          const g = clusterGroup[ci];
          if (g < 0) continue;
          gSumX[g] += cx[ci] * clusterSize[ci];
          gSumY[g] += cy[ci] * clusterSize[ci];
          gSumN[g] += clusterSize[ci];
        }
        for (let ci = 0; ci < cCount; ci += 1) {
          const g = clusterGroup[ci];
          if (g < 0 || !gSumN[g]) continue;
          cx[ci] += (gSumX[g] / gSumN[g] - cx[ci]) * 0.055;
          cy[ci] += (gSumY[g] / gSumN[g] - cy[ci]) * 0.055;
        }
      }
      for (let a = 0; a < cCount; a += 1) {
        for (let b = a + 1; b < cCount; b += 1) {
          const dx = cx[b] - cx[a];
          const dy = cy[b] - cy[a];
          const want = (cRad[a] + cRad[b]) * 0.94;
          const d2 = dx * dx + dy * dy;
          if (d2 >= want * want || d2 < 1e-6) continue;
          const d = Math.sqrt(d2);
          const push = ((want - d) / d) * 0.3;
          cx[b] += dx * push;
          cy[b] += dy * push;
          cx[a] -= dx * push;
          cy[a] -= dy * push;
        }
      }
      for (let i = 0; i < n; i += 1) {
        const ci = clusterOf[i];
        if (ci < 0) continue;
        vx[i] += (cx[ci] - x[i]) * MAP_CLUSTER_PULL * alpha;
        vy[i] += (cy[ci] - y[i]) * MAP_CLUSTER_PULL * alpha;
      }
    }

    // --- gravity, then integrate ---
    // Gravity is deliberately anisotropic: a map is read in a landscape frame,
    // so the pull inwards is weaker across than down and the finished picture
    // settles wide rather than round. The ratio is a constant, not the
    // viewport — the layout must not depend on the window it is drawn in, or
    // two readers on two screens would be looking at two different maps.
    for (let i = 0; i < n; i += 1) {
      vx[i] += (0 - x[i]) * MAP_GRAVITY * 0.62 * alpha;
      vy[i] += (0 - y[i]) * MAP_GRAVITY * 1.5 * alpha;
      vx[i] *= MAP_VELOCITY_KEEP;
      vy[i] *= MAP_VELOCITY_KEEP;
      x[i] += vx[i];
      y[i] += vy[i];
    }
  }

  // A few purely positional passes so the drawing has no overlaps left in it.
  for (let pass = 0; pass < 5; pass += 1) {
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        const dx = x[j] - x[i];
        const dy = y[j] - y[i];
        const want = rad[i] + rad[j] + MAP_COLLIDE_PAD;
        const d2 = dx * dx + dy * dy;
        if (d2 >= want * want) continue;
        const d = Math.sqrt(d2) || 1e-3;
        const push = ((want - d) / d) * 0.5;
        x[j] += dx * push;
        y[j] += dy * push;
        x[i] -= dx * push;
        y[i] -= dy * push;
      }
    }
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i += 1) {
    minX = Math.min(minX, x[i] - rad[i]);
    minY = Math.min(minY, y[i] - rad[i]);
    maxX = Math.max(maxX, x[i] + rad[i]);
    maxY = Math.max(maxY, y[i] + rad[i]);
  }
  if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = 1; maxY = 1; }

  const pos = new Map();
  for (let i = 0; i < n; i += 1) {
    pos.set(nodes[i].id, {
      // Rounded, so the DOM a test compares is the same string twice over and
      // a last-bit difference can never read as a moved map.
      x: Math.round((x[i] - minX + MAP_FORCE_PAD) * 100) / 100,
      y: Math.round((y[i] - minY + MAP_FORCE_PAD) * 100) / 100,
      r: Math.round(rad[i] * 100) / 100,
      degree: deg[i],
    });
  }
  return {
    mode: 'force',
    pos,
    width: maxX - minX + MAP_FORCE_PAD * 2,
    height: maxY - minY + MAP_FORCE_PAD * 2,
    offset: 0,
    iterations,
    ms: Math.round(performance.now() - t0),
  };
}

// ---- the tidy tree ---------------------------------------------------------
//
// A layered tree, written here rather than imported: one column per depth,
// siblings stacked in the order the tree shows them, and a parent centred on
// its children. Everything below is a pure function of the server's payload,
// and the server orders that payload deterministically — so the same record
// lands in the same place every time it is drawn.

function mapTreeLayout(visible) {
  const { nodes, edges } = visible;
  const pos = new Map();
  const kids = new Map();
  const parentOf = new Map();
  for (const e of edges) {
    if (e.kind !== 'child') continue;
    if (parentOf.has(e.to)) continue; // a page has one parent
    parentOf.set(e.to, e.from);
    if (!kids.has(e.from)) kids.set(e.from, []);
    kids.get(e.from).push(e.to);
  }

  const pages = nodes.filter((n) => n.kind === 'page');
  const inTree = pages.filter((n) => !n.external);
  const roots = inTree.filter((n) => !parentOf.has(n.id));
  const colX = (depth) => depth * (MAP_NODE_W + MAP_COL_GAP);

  let cursor = 0;
  let maxDepth = 0;
  const placed = new Set();
  const place = (id, depth) => {
    if (placed.has(id)) return pos.get(id)?.y ?? 0;
    placed.add(id);
    maxDepth = Math.max(maxDepth, depth);
    const children = (kids.get(id) ?? []).filter((c) => !placed.has(c));
    if (!children.length) {
      const y = cursor;
      cursor += MAP_NODE_H + MAP_ROW_GAP;
      pos.set(id, { x: colX(depth), y, depth });
      return y;
    }
    const ys = children.map((c) => place(c, depth + 1));
    const y = (ys[0] + ys[ys.length - 1]) / 2;
    pos.set(id, { x: colX(depth), y, depth });
    return y;
  };
  for (const root of roots) {
    place(root.id, 0);
    cursor += MAP_ROOT_GAP;
  }
  // A page whose parent the filters hid still belongs on the map, at the root.
  for (const page of inTree) if (!placed.has(page.id)) place(page.id, 0);

  // Pages linked out of this collection sit past the deepest branch, and
  // sources past those: the eye reads left to right from "our tree" to "what
  // it reaches".
  const stack = (ids, depth, desired) => {
    if (!ids.length) return depth;
    const wanted = ids
      .map((id) => ({ id, y: desired(id) }))
      .sort((a, b) => a.y - b.y || a.id.localeCompare(b.id));
    let last = -Infinity;
    for (const item of wanted) {
      const y = Math.max(item.y, last + MAP_NODE_H + MAP_ROW_GAP);
      pos.set(item.id, { x: colX(depth), y, depth });
      last = y;
    }
    maxDepth = Math.max(maxDepth, depth);
    return depth + 1;
  };
  const meanOf = (ids) => {
    const ys = ids.map((id) => pos.get(id)?.y).filter((y) => typeof y === 'number');
    return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : cursor;
  };
  const external = pages.filter((n) => n.external).map((n) => n.id);
  const nextDepth = stack(external, maxDepth + 1, (id) =>
    meanOf(edges.filter((e) => e.to === id).map((e) => e.from)),
  );
  const sources = nodes.filter((n) => n.kind === 'source').map((n) => n.id);
  stack(sources, Math.max(nextDepth, maxDepth + 1), (id) =>
    meanOf(edges.filter((e) => e.kind === 'reference' && e.to === id).map((e) => e.from)),
  );

  let width = 0;
  let height = 0;
  for (const p of pos.values()) {
    width = Math.max(width, p.x + MAP_NODE_W);
    height = Math.max(height, p.y + MAP_NODE_H);
  }
  return { mode: 'tree', pos, width: width + MAP_PAD * 2, height: height + MAP_PAD * 2, offset: MAP_PAD };
}

// ---- drawing ---------------------------------------------------------------

function mapClip(text, max = 24) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function mapNodeMeta(n) {
  if (n.kind === 'source') {
    return `Source${n.type ? ` · ${n.type}` : ''}`;
  }
  const type = TYPE_LABELS[n.type] ?? n.type ?? 'Page';
  return `${type} · ${STATUS_LABELS[n.status] ?? n.status}`;
}

function mapNodeLabel(n, degree) {
  const reach = typeof degree === 'number' ? `, ${degree} connection${degree === 1 ? '' : 's'} on this map` : '';
  if (n.kind === 'source') {
    return `${n.title}. External source${n.type ? `, kind ${n.type}` : ''}, referenced by ${n.references} page${n.references === 1 ? '' : 's'}${reach}.`;
  }
  return `${n.title}. ${mapNodeMeta(n)}. ${PROVENANCE_LABELS[n.provenance]}${n.external ? ', in another collection' : ''}${reach}.`;
}

// The reveal: a stagger from the middle of the picture outwards, capped so the
// whole thing is over inside ~520ms however many nodes there are. It animates
// arrival, never position — the layout was final before the first frame.
function mapRevealDelay(rank, total) {
  const span = 260;
  return Math.round((rank / Math.max(1, total - 1)) * span);
}

// ---- constellation drawing --------------------------------------------------

function mapForceEdgePath(a, b, kind, seed) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  // Parallel edges between the same two clusters would otherwise stack into one
  // stroke; a curve whose side and depth come from the pair's own hash pulls
  // them apart, and does it the same way on every reload.
  const bend = { child: 0.05, link: 0.13, reference: 0.1, conflicts_with: 0.16, supersedes: 0.09 }[kind] ?? 0.08;
  const side = seed & 1 ? 1 : -1;
  const amt = len * bend * side * (0.75 + ((seed >>> 8) & 0xff) / 512);
  const mx = (a.x + b.x) / 2 - (dy / len) * amt;
  const my = (a.y + b.y) / 2 + (dx / len) * amt;
  return `M ${a.x} ${a.y} Q ${Math.round(mx * 100) / 100} ${Math.round(my * 100) / 100} ${b.x} ${b.y}`;
}

function mapGradientDefs(palette) {
  const stops = (id, cls, style) => `
    <radialGradient id="${id}" class="${cls}" style="${style}" cx="34%" cy="28%" r="78%">
      <stop offset="0" class="map-grad-hi"></stop>
      <stop offset="1" class="map-grad-lo"></stop>
    </radialGradient>`;
  const cluster = [...palette.gradients.values()]
    .map((g) => stops(g.id, `mg-s${g.shade}`, `--h: ${g.hue}`))
    .join('');
  return `
    ${cluster}
    <radialGradient id="mg-source" cx="34%" cy="26%" r="80%">
      <stop offset="0" class="map-grad-source-hi"></stop>
      <stop offset="1" class="map-grad-source-lo"></stop>
    </radialGradient>
    <radialGradient id="mg-mute" cx="34%" cy="28%" r="78%">
      <stop offset="0" class="map-grad-mute-hi"></stop>
      <stop offset="1" class="map-grad-mute-lo"></stop>
    </radialGradient>`;
}

function mapForceSvgHTML(visible, layout, palette) {
  const { pos } = layout;
  const marker = (kind) => `
    <marker id="map-arrow-${kind}" class="map-arrow map-arrow-${kind}" viewBox="0 0 8 8"
      refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 8 4 L 0 8 z"></path>
    </marker>`;

  const edges = visible.edges
    .map((e) => {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      if (!a || !b) return '';
      const seed = mapHash32(`${e.kind}:${e.from}>${e.to}`);
      const hue = palette.swatch.get(e.from)?.hue ?? palette.swatch.get(e.to)?.hue;
      // Only the DIRECTED edges keep an arrowhead in this layout: the tree's
      // direction is carried by the shape itself — a parent is the bigger node
      // its children hang off — and a conflict has no direction to carry. See
      // MAP_EDGE_ARROW. Hovering names the relation either way, and the list
      // states every one of them in words.
      const head = MAP_EDGE_ARROW[e.kind] ? ` marker-end="url(#map-arrow-${esc(e.kind)})"` : '';
      return `<path class="map-edge map-edge-${esc(e.kind)}"${hue === undefined ? '' : ` style="--h: ${hue}"`}
        d="${mapForceEdgePath(a, b, e.kind, seed)}"${head}
        data-from="${esc(e.from)}" data-to="${esc(e.to)}"></path>`;
    })
    .join('');

  // Label tiers by how connected a node is: the hubs are named at every zoom,
  // and each step in gives another band its names. Ranked deterministically —
  // degree first, then id — so the same page is always in the same tier.
  const ranked = [...visible.nodes].sort((a, b) => {
    const da = visible.degree.get(a.id) ?? 0;
    const db = visible.degree.get(b.id) ?? 0;
    return db - da || a.id.localeCompare(b.id);
  });
  const total = ranked.length;
  const hubCount = Math.max(4, Math.min(22, Math.round(total * 0.05)));
  const tierOf = new Map();
  ranked.forEach((n, i) => {
    if (i < hubCount) tierOf.set(n.id, 0);
    else if (i < hubCount + total * 0.14) tierOf.set(n.id, 1);
    else if (i < total * 0.45) tierOf.set(n.id, 2);
    else tierOf.set(n.id, 3);
  });
  // Sources are few and they are the map's answer to "where does this come
  // from"; they are never demoted past the second tier.
  for (const n of visible.nodes) {
    if (n.kind === 'source') tierOf.set(n.id, Math.min(tierOf.get(n.id) ?? 3, 1));
  }

  // The reveal order runs outward from the centre of the picture.
  const cxm = layout.width / 2;
  const cym = layout.height / 2;
  const byDistance = [...visible.nodes].sort((a, b) => {
    const pa = pos.get(a.id);
    const pb = pos.get(b.id);
    const da = Math.hypot(pa.x - cxm, pa.y - cym);
    const db = Math.hypot(pb.x - cxm, pb.y - cym);
    return da - db || a.id.localeCompare(b.id);
  });
  const delayOf = new Map(byDistance.map((n, i) => [n.id, mapRevealDelay(i, byDistance.length)]));

  const nodes = visible.nodes
    .map((n) => {
      const p = pos.get(n.id);
      if (!p) return '';
      const degree = visible.degree.get(n.id) ?? 0;
      const href = n.kind === 'source' ? '#/sources' : `#/pages/${encodeURIComponent(n.id)}`;
      const sw = palette.swatch.get(n.id);
      const fill = n.kind === 'source'
        ? 'url(#mg-source)'
        : n.status === 'archived' || !sw
          ? 'url(#mg-mute)'
          : `url(#mg-${sw.hue}-${sw.shade})`;
      const cls = [
        'map-node',
        `map-node-${n.kind}`,
        `pv-${esc(n.provenance)}`,
        n.kind === 'page' ? `st-${esc(n.status)}` : 'st-source',
        n.external ? 'is-external' : '',
        `lt-${tierOf.get(n.id) ?? 3}`,
      ].join(' ');
      const r = p.r;
      // Standing that needs finding gets a ring outside the node; the Canonical
      // mark gets a lit core inside it. Both are drawn only where they mean
      // something, so a five-hundred-node map is not five hundred haloes.
      const ring = n.status === 'needs_update' || n.status === 'in_review'
        ? `<circle class="mn-ring" r="${Math.round((r + 3.6) * 100) / 100}"></circle>`
        : '';
      const halo = n.provenance === 'federated' && n.kind === 'page'
        ? `<circle class="mn-halo" r="${Math.round((r + 5.2) * 100) / 100}"></circle>`
        : '';
      const core = n.status === 'canonical'
        ? `<circle class="mn-core" r="${Math.round(Math.max(1.8, r * 0.3) * 100) / 100}"></circle>`
        : '';
      const body = n.kind === 'source'
        ? `<rect class="mn-body" x="${-r}" y="${-r}" width="${r * 2}" height="${r * 2}" rx="${Math.round(r * 0.42 * 100) / 100}" fill="${fill}"></rect>`
        : `<circle class="mn-body" r="${r}" fill="${fill}"></circle>`;
      return `<a class="${cls}" href="${esc(href)}" tabindex="0" data-node="${esc(n.id)}"
        transform="translate(${p.x} ${p.y})" style="--d: ${delayOf.get(n.id) ?? 0}ms"
        aria-label="${esc(mapNodeLabel(n, degree))}">
        <title>${esc(mapNodeLabel(n, degree))}</title>
        <g class="mn-in">${halo}${ring}${body}${core}
        <text class="mn-label" y="${Math.round((r + 12) * 100) / 100}">${esc(mapClip(n.title, 30))}</text>
        </g>
      </a>`;
    })
    .join('');

  return `
    <svg class="map-svg map-svg-force" id="map-svg" tabindex="0" role="application" data-labels="1"
      aria-label="Knowledge map, constellation view. Drag to pan, scroll or use the buttons to zoom, Tab to move between pages.">
      <defs>${Object.keys(MAP_EDGE_ARROW).map(marker).join('')}${mapGradientDefs(palette)}</defs>
      <g id="map-canvas">
        <g class="map-edges">${edges}</g>
        <g class="map-nodes" id="map-nodes">${nodes}</g>
      </g>
    </svg>`;
}

// ---- tree drawing ------------------------------------------------------------

function mapTreeEdgePath(a, b) {
  const forward = b.x >= a.x + MAP_NODE_W;
  const x1 = forward ? a.x + MAP_NODE_W : a.x;
  const x2 = forward ? b.x : b.x + MAP_NODE_W;
  const y1 = a.y + MAP_NODE_H / 2;
  const y2 = b.y + MAP_NODE_H / 2;
  const d = Math.max(30, Math.abs(x2 - x1) / 2);
  const c1 = forward ? x1 + d : x1 - d;
  const c2 = forward ? x2 - d : x2 + d;
  return `M ${x1} ${y1} C ${c1} ${y1} ${c2} ${y2} ${x2} ${y2}`;
}

function mapTreeSvgHTML(visible, layout) {
  const { pos, offset } = layout;
  const marker = (kind) => `
    <marker id="map-arrow-${kind}" class="map-arrow map-arrow-${kind}" viewBox="0 0 8 8"
      refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 8 4 L 0 8 z"></path>
    </marker>`;
  const edges = visible.edges
    .map((e) => {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      if (!a || !b) return '';
      // The tree layout keeps the child arrowhead — a column layout states the
      // parent relation with it — but a conflict still carries none: it has no
      // direction, here or in the constellation.
      const head = e.kind === 'conflicts_with' ? '' : ` marker-end="url(#map-arrow-${esc(e.kind)})"`;
      return `<path class="map-edge map-edge-${esc(e.kind)}" d="${mapTreeEdgePath(a, b)}"${head}
        data-from="${esc(e.from)}" data-to="${esc(e.to)}"></path>`;
    })
    .join('');
  const ordered = [...visible.nodes].sort((a, b) => {
    const pa = pos.get(a.id);
    const pb = pos.get(b.id);
    if (!pa || !pb) return 0;
    return pa.x - pb.x || pa.y - pb.y || a.id.localeCompare(b.id);
  });
  const delayOf = new Map(ordered.map((n, i) => [n.id, mapRevealDelay(i, ordered.length)]));
  const nodes = visible.nodes
    .map((n) => {
      const p = pos.get(n.id);
      if (!p) return '';
      const href = n.kind === 'source' ? '#/sources' : `#/pages/${encodeURIComponent(n.id)}`;
      const cls = [
        'map-node',
        `map-node-${n.kind}`,
        `pv-${esc(n.provenance)}`,
        n.kind === 'page' ? `st-${esc(n.status)}` : 'st-source',
        n.external ? 'is-external' : '',
      ].join(' ');
      return `<a class="${cls}" href="${esc(href)}" tabindex="0" data-node="${esc(n.id)}"
        transform="translate(${p.x} ${p.y})" style="--d: ${delayOf.get(n.id) ?? 0}ms"
        aria-label="${esc(mapNodeLabel(n, visible.degree.get(n.id) ?? 0))}">
        <title>${esc(mapNodeLabel(n, visible.degree.get(n.id) ?? 0))}</title>
        <g class="mn-in">
          <rect class="map-node-box" width="${MAP_NODE_W}" height="${MAP_NODE_H}" rx="${n.kind === 'source' ? 22 : 10}"></rect>
          <rect class="map-node-stripe" x="0" y="0" width="4" height="${MAP_NODE_H}" rx="2"></rect>
          <text class="map-node-title" x="15" y="21">${esc(mapClip(n.title))}</text>
          <text class="map-node-meta" x="15" y="37">${esc(mapClip(mapNodeMeta(n), 28))}</text>
        </g>
      </a>`;
    })
    .join('');
  return `
    <svg class="map-svg map-svg-tree" id="map-svg" tabindex="0" role="application"
      aria-label="Knowledge map, tree view. Drag to pan, scroll or use the buttons to zoom, Tab to move between pages.">
      <defs>${['child', 'link', 'reference', 'supersedes'].map(marker).join('')}</defs>
      <g id="map-canvas">
        <g class="map-edges" transform="translate(${offset} ${offset})">${edges}</g>
        <g class="map-nodes" id="map-nodes" transform="translate(${offset} ${offset})">${nodes}</g>
      </g>
    </svg>`;
}

// ---- the list, which is the same data ---------------------------------------

function mapProvTag(n) {
  const detail =
    n.provenance === 'imported' && n.origin
      ? ` from ${n.origin.system}`
      : '';
  return `<span class="map-prov map-prov-${esc(n.provenance)}"
    title="${esc(PROVENANCE_HELP[n.provenance])}">${esc(PROVENANCE_LABELS[n.provenance])}${esc(detail)}</span>`;
}

function mapOriginNote(n) {
  if (!n.origin) return '';
  return `<span class="map-origin muted" title="A migrated source should be retired; this page still traces to one.">migrated from ${esc(n.origin.system)}${n.origin.file ? ` · ${esc(n.origin.file)}` : ''}</span>`;
}

function mapListHTML(visible, collectionNames, grouped) {
  const { nodes, edges } = visible;
  const byId = visible.byId;
  const kids = new Map();
  const parentOf = new Map();
  for (const e of edges) {
    if (e.kind !== 'child') continue;
    if (parentOf.has(e.to)) continue;
    parentOf.set(e.to, e.from);
    if (!kids.has(e.from)) kids.set(e.from, []);
    kids.get(e.from).push(e.to);
  }
  const linksFrom = new Map();
  const refsFrom = new Map();
  // §7's relations. A conflict is symmetric, so both ends state it; a
  // supersession is directed, so each end states its own half of it.
  const conflictsWith = new Map();
  const supersedes = new Map();
  const supersededBy = new Map();
  const push = (bucket, key, value) => {
    if (!bucket.has(key)) bucket.set(key, []);
    bucket.get(key).push(value);
  };
  for (const e of edges) {
    if (e.kind === 'link') push(linksFrom, e.from, e.to);
    else if (e.kind === 'reference') push(refsFrom, e.from, e.to);
    else if (e.kind === 'conflicts_with') {
      push(conflictsWith, e.from, e.to);
      push(conflictsWith, e.to, e.from);
    } else if (e.kind === 'supersedes') {
      push(supersedes, e.from, e.to);
      push(supersededBy, e.to, e.from);
    }
  }

  const pagesOf = (bucket, id) => (bucket.get(id) ?? []).map((x) => byId.get(x)).filter(Boolean);
  const pageLinks = (list) => list.map((t) => `<a href="#/pages/${esc(t.id)}">${esc(t.title)}</a>`).join(', ');

  const row = (n) => {
    const links = (linksFrom.get(n.id) ?? []).map((id) => byId.get(id)).filter(Boolean);
    const refs = (refsFrom.get(n.id) ?? []).map((id) => byId.get(id)).filter(Boolean);
    const conflicts = pagesOf(conflictsWith, n.id);
    const replaces = pagesOf(supersedes, n.id);
    const replacedBy = pagesOf(supersededBy, n.id);
    const degree = visible.degree.get(n.id) ?? 0;
    return `
      <div class="map-row">
        <a class="map-row-title" href="#/pages/${esc(n.id)}">${esc(n.title)}</a>
        ${badge(n.status, 'sm')}
        <span class="muted map-row-type">${esc(TYPE_LABELS[n.type] ?? n.type ?? '')}</span>
        ${mapProvTag(n)}
        ${n.external ? '<span class="map-external-tag" title="Linked from this collection, but held in another">other collection</span>' : ''}
        ${mapOriginNote(n)}
        <span class="muted map-row-degree" title="How many edges on this map touch this page — the same number that sizes its node in the drawing.">${degree} connection${degree === 1 ? '' : 's'}</span>
        ${links.length ? `<span class="map-row-edges">links to ${links.map((t) => `<a href="#/pages/${esc(t.id)}">${esc(t.title)}</a>`).join(', ')}</span>` : ''}
        ${refs.length ? `<span class="map-row-edges">reads from ${refs.map((t) => `<span class="map-source-name">${esc(t.title)}</span>`).join(', ')}</span>` : ''}
        ${conflicts.length ? `<span class="map-row-edges is-conflict">conflicts with ${pageLinks(conflicts)}</span>` : ''}
        ${replaces.length ? `<span class="map-row-edges is-supersedes">supersedes ${pageLinks(replaces)}</span>` : ''}
        ${replacedBy.length ? `<span class="map-row-edges is-supersedes">superseded by ${pageLinks(replacedBy)}</span>` : ''}
      </div>`;
  };

  const branch = (ids, depth) => {
    if (!ids.length || depth > 24) return '';
    return `<ul class="map-list">${ids
      .map((id) => {
        const n = byId.get(id);
        if (!n) return '';
        return `<li>${row(n)}${branch(kids.get(id) ?? [], depth + 1)}</li>`;
      })
      .join('')}</ul>`;
  };

  const pages = nodes.filter((n) => n.kind === 'page');
  const rootIds = pages.filter((n) => !n.external && !parentOf.has(n.id)).map((n) => n.id);
  const external = pages.filter((n) => n.external);
  const sources = nodes.filter((n) => n.kind === 'source');
  const referencedBy = (sourceId) =>
    edges.filter((e) => e.kind === 'reference' && e.to === sourceId).map((e) => byId.get(e.from)).filter(Boolean);

  // Whole-record: the same trees, under the collection headings the drawing
  // colours by. One reading of the data, two presentations of it. A single
  // collection's map is one tree set and gets no headings, even though the
  // client knows every collection's name.
  let treeHTML;
  if (grouped) {
    const buckets = new Map();
    for (const id of rootIds) {
      const key = byId.get(id)?.collectionId ?? '';
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(id);
    }
    const order = [...buckets.keys()].sort((a, b) =>
      (collectionNames.get(a) ?? a).localeCompare(collectionNames.get(b) ?? b));
    treeHTML = order
      .map((key) => `
        <h3 class="map-list-collection">${esc(collectionNames.get(key) ?? key ?? 'Uncollected')}</h3>
        ${branch(buckets.get(key), 0)}`)
      .join('');
  } else {
    treeHTML = branch(rootIds, 0);
  }

  return `
    <div class="map-list-wrap">
      <h2 class="h-small">${grouped ? 'The record' : 'The tree'}${rootIds.length ? '' : ' — nothing matches these filters'}</h2>
      ${treeHTML}
      ${external.length ? `
        <h2 class="h-small">Linked from elsewhere in the record</h2>
        <ul class="map-list">${external.map((n) => `<li>${row(n)}</li>`).join('')}</ul>` : ''}
      ${sources.length ? `
        <h2 class="h-small">Sources ${grouped ? 'the record' : 'this collection'} reads from</h2>
        <ul class="map-list map-source-list">
          ${sources.map((s) => `
            <li>
              <div class="map-row">
                <span class="map-row-title map-source-name">${esc(s.title)}</span>
                <span class="muted map-row-type">${esc(s.type ?? 'source')}</span>
                ${s.authMode ? `<span class="kind-tag${s.authMode === 'service' ? ' ref-service' : ''}">${esc(s.authMode === 'service' ? 'service-resolved' : 'per asker')}</span>` : ''}
                ${s.freshnessWindowMs !== null ? `<span class="muted">fresh for ${esc(fmtDuration(s.freshnessWindowMs))}</span>` : ''}
                <span class="map-row-edges">read by ${referencedBy(s.id).map((p) => `<a href="#/pages/${esc(p.id)}">${esc(p.title)}</a>`).join(', ') || '—'}</span>
              </div>
            </li>`).join('')}
        </ul>` : ''}
    </div>`;
}

// ---- legend and filters ------------------------------------------------------

/**
 * The key, ON the picture.
 *
 * The full legend below the stage has been there since the map shipped and it
 * is good; it is also below the fold, and a colour key a reader has to scroll
 * to find is a colour key they do not have (USER-TESTING.md T4.6 — "244
 * unlabelled dots with no colour key"). This is the short version, drawn in
 * the corner of the drawing itself: what a dot is, what a square is, what the
 * ring and the core mean, and what the hues stand for. It links to the long
 * one rather than repeating it.
 *
 * Only over a drawing. The list needs no key: it writes everything out.
 */
function mapKeyHTML(palette, scope) {
  const hues = palette && palette.keys.length
    ? `<div class="map-key-row"><span class="map-key-hues">${palette.keys.slice(0, 4)
        .map((_, i) => `<span class="map-chip map-chip-cluster mg-s1" style="--h: ${palette.hueOf(i)}"></span>`)
        .join('')}</span><span>${scope === 'all' && !palette.byRoot
          ? 'one hue per collection, one shade per tree root'
          : 'one hue per tree root'} — the record\'s own structure, never a similarity Canon does not hold</span></div>`
    : '';
  const row = (chip, text) => `<div class="map-key-row"><span class="${chip}"></span><span>${text}</span></div>`;
  return `
    <div class="map-key" id="map-key">
      ${row('map-chip map-chip-page', 'a page, drawn as big as it is connected')}
      ${row('map-chip map-chip-source', 'an external source, drawn square')}
      ${row('map-chip map-chip-canonical', `${badge('canonical', 'sm')} a lit core`)}
      ${row('map-chip map-chip-needs', `${badge('needs_update', 'sm')} an amber ring, the only one on the map`)}
      ${row('map-chip map-chip-review', `${badge('in_review', 'sm')} a dotted ring`)}
      ${row('map-chip map-chip-draft', `${badge('draft', 'sm')} ${badge('archived', 'sm')} drawn faint`)}
      ${hues}
      <div class="map-key-row"><span></span><span><a href="#" id="map-key-more">The full key ↓</a></span></div>
    </div>`;
}

function mapLegendHTML(palette, collectionNames, scope) {
  // The swatch carries its own arrowhead rather than borrowing the map's: the
  // legend is shown beside the list too, where the map's <defs> do not exist.
  const swatch = (kind) => `<svg class="map-legend-edge" viewBox="0 0 42 10" aria-hidden="true">
    <defs><marker id="map-legend-arrow-${kind}" class="map-arrow map-arrow-${kind}" viewBox="0 0 8 8"
      refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 8 4 L 0 8 z"></path></marker></defs>
    <path class="map-edge map-edge-${kind}" d="M 1 5 L 34 5" marker-end="url(#map-legend-arrow-${kind})"></path></svg>`;

  // Which community each colour is. Named, because a colour that stands for
  // something nobody can look up is decoration.
  const communities = palette
    ? palette.keys.slice(0, 14).map((key, i) => {
        const name = palette.byRoot
          ? (state.map?.graph?.nodes?.find((n) => n.id === key)?.title ?? 'Tree root')
          : (collectionNames?.get(key) ?? key);
        return `<span class="map-community" style="--h: ${palette.hueOf(i)}">
          <span class="map-chip map-chip-cluster mg-s1"></span>${esc(mapClip(name, 26))}</span>`;
      }).join('')
    : '';
  const more = palette && palette.keys.length > 14 ? `<span class="muted">and ${palette.keys.length - 14} more</span>` : '';

  return `
    <section class="panel map-legend">
      <h2 class="h-small">How to read this map</h2>
      <div class="map-legend-grid">
        <div>
          <h3 class="map-legend-h">Nodes</h3>
          <p class="map-legend-item"><span class="map-chip map-chip-page"></span> A page in the record. It is drawn as
            big as it is connected — √(edges on this map) — so the pages everything hangs off are the ones you see first.</p>
          <p class="map-legend-item"><span class="map-chip map-chip-source"></span> A registered external source, drawn
            square because it is a different kind of thing. Canon never copies what it owns.</p>
          <p class="map-legend-item"><span class="map-chip map-chip-external"></span> A page in another collection,
            reached by a link.</p>
        </div>
        <div>
          <h3 class="map-legend-h">Edges — the explicit graph, never an inferred one</h3>
          ${MAP_EDGE_KINDS.map((k) => `
            <p class="map-legend-item">${swatch(k)} <strong>${esc(EDGE_LABELS[k])}</strong> — ${esc(EDGE_HELP[k])}</p>`).join('')}
          <p class="map-legend-note muted">Every one of these is a relation somebody wrote down, including the last two:
            a conflict is asserted by a person, with a note saying how the pages disagree, and Canon draws it rather
            than deciding it.</p>
          <p class="map-legend-note muted">In the constellation, tree edges carry no arrowhead: the parent is the node
            its children hang off, and five hundred arrowheads would be a texture rather than information. A conflict
            carries none in either layout, because it is symmetric and an arrow would state a direction the record does
            not hold. Hover any node to light its neighbourhood, or read the list, where every relation is written out.</p>
        </div>
        <div>
          <h3 class="map-legend-h">Where the material comes from</h3>
          ${['authored', 'imported', 'federated'].map((p) => `
            <p class="map-legend-item"><span class="map-chip pv-${p}"></span>
              <strong>${esc(PROVENANCE_LABELS[p])}</strong> — ${esc(PROVENANCE_HELP[p])}</p>`).join('')}
          <p class="map-legend-note muted">A page that was imported and also reads from a live source is drawn as
            federated; its migration origin is still named on the node and in the list.</p>
        </div>
        <div>
          <h3 class="map-legend-h">Standing</h3>
          <p class="map-legend-item"><span class="map-chip map-chip-canonical"></span>
            ${badge('canonical', 'sm')} carries a lit core.</p>
          <p class="map-legend-item"><span class="map-chip map-chip-needs"></span>
            ${badge('needs_update', 'sm')} wears an amber ring — the only amber ring on the map, so a page past its
            review date is findable at a glance, at any zoom.</p>
          <p class="map-legend-item"><span class="map-chip map-chip-review"></span>
            ${badge('in_review', 'sm')} wears a dotted one.</p>
          <p class="map-legend-item"><span class="map-chip map-chip-draft"></span>
            ${badge('draft', 'sm')} and ${badge('archived', 'sm')} are drawn faint: they are not the record yet, or
            not any more. In the tree layout, standing is the bar down a node's left edge instead.</p>
          <p class="map-legend-note muted">Sources carry no status: standing belongs to the record, and a source is
            not part of it.</p>
          <h3 class="map-legend-h">And what each of them means</h3>
          ${statusKeyHTML()}
        </div>
        ${communities ? `
          <div class="map-legend-wide">
            <h3 class="map-legend-h">Communities — ${scope === 'all' && !palette.byRoot ? 'one hue per collection, one shade per tree root inside it' : 'one hue per tree root'}</h3>
            <p class="map-legend-note muted">The clusters are the record's own structure: the collection a page is in
              and the tree root it hangs from. Nothing here is inferred from similarity — Canon has no such edge, and a
              map that invented one would be believed, because it is a picture.</p>
            <div class="map-communities">${communities}${more}</div>
          </div>` : ''}
      </div>
    </section>`;
}

function mapFiltersHTML(graph, filters, collectionNames) {
  const count = (fn) => graph.nodes.filter(fn).length;
  const box = (group, value, label, n, help) => `
    <label class="map-check" title="${esc(help ?? '')}">
      <input type="checkbox" data-filter="${esc(group)}" value="${esc(value)}" ${filters[group].has(value) ? 'checked' : ''}>
      <span>${label}${n === null ? '' : ` <span class="muted">${n}</span>`}</span>
    </label>`;
  const statuses = ['draft', 'in_review', 'canonical', 'needs_update', 'archived'].filter((s) =>
    graph.nodes.some((n) => n.kind === 'page' && n.status === s),
  );
  const collectionsFilter = filters.collections && collectionNames && collectionNames.size > 1
    ? `<fieldset class="map-filter map-filter-collections">
        <legend>Collections</legend>
        ${[...collectionNames.entries()]
          .sort((a, b) => a[1].localeCompare(b[1]))
          .map(([id, name]) => box('collections', id, esc(name),
            count((n) => n.kind === 'page' && n.collectionId === id)))
          .join('')}
      </fieldset>`
    : '';
  return `
    <div class="map-filters">
      ${collectionsFilter}
      <fieldset class="map-filter">
        <legend>Provenance</legend>
        ${['authored', 'imported', 'federated']
          .map((p) => box('provenance', p, esc(PROVENANCE_LABELS[p]),
            count((n) => n.kind === 'page' && (n.provenance === p || (p === 'imported' && !!n.origin))),
            PROVENANCE_HELP[p]))
          .join('')}
      </fieldset>
      <fieldset class="map-filter">
        <legend>Status</legend>
        ${statuses
          .map((s) => box('status', s, badge(s, 'sm'), count((n) => n.kind === 'page' && n.status === s)))
          .join('')}
      </fieldset>
      <fieldset class="map-filter">
        <legend>Edges</legend>
        ${MAP_EDGE_KINDS
          .map((k) => box('edges', k, esc(EDGE_LABELS[k]), graph.edges.filter((e) => e.kind === k).length, EDGE_HELP[k]))
          .join('')}
      </fieldset>
    </div>`;
}

// ---- the view ----------------------------------------------------------------

function mapUnavailableHTML() {
  return `
    <div class="empty-state">
      <h2>The knowledge map is not available yet</h2>
      <p>This Canon server does not serve <code>/collections/:id/graph</code>. The tree in the
        sidebar and each page's related list still show how the record hangs together.</p>
      <p><a class="btn" href="#/">Back to collections</a></p>
    </div>`;
}

function mapTruncatedNotice(truncated) {
  if (!truncated) return '';
  const both = Number.isFinite(truncated.limit) && Number.isFinite(truncated.total);
  // What the server sends and nothing more. It caps by whole collections from
  // the tail, so the client does not know WHICH nodes are missing and does not
  // guess: it says how many, and where the whole record still is.
  return `<div class="notice">${both
    ? `This record is larger than one map can hold, so the picture is partial: it stops at the
       server's cap, and ${truncated.limit} of ${truncated.total} nodes are drawn.`
    : 'This is larger than one map can hold, so the picture is partial: it stops at the server\'s cap.'}
    The tree and search still reach every page.</div>`;
}

async function viewMap(scopeParam) {
  if (!(await detectMap())) {
    app.innerHTML = `<div class="page-wide">${mapUnavailableHTML()}</div>`;
    return;
  }
  markNav('map');

  const collections = await api('GET', '/collections').catch(() => []);
  const list = Array.isArray(collections) ? collections : [];

  // No scope in the hash: the whole record when the server serves it, and
  // otherwise exactly what this view has always done.
  let scope = scopeParam;
  if (!scope) {
    if (await detectWholeGraph()) scope = 'all';
    else if (list.length === 1) {
      location.replace(`#/collections/${encodeURIComponent(list[0].id)}/map`);
      return;
    }
  }
  if (scope === 'all' && !(await detectWholeGraph())) scope = null;

  if (!scope) {
    app.innerHTML = `
      <div class="page-wide">
        <div class="page-head"><div>
          <h1>Knowledge map</h1>
          <p class="muted map-lede">Pick a collection to see how its pages hang together — the tree, the
            links people wrote, and the outside systems it still reads from.</p>
        </div></div>
        ${list.length ? `
          <div class="card-grid">
            ${list.map((c) => `
              <a class="card collection-card" href="#/collections/${esc(c.id)}/map">
                <h3>${esc(c.name)}</h3>
                <p class="muted">${esc(c.description || 'No description.')}</p>
              </a>`).join('')}
          </div>` : `
          <div class="empty-state"><h2>Nothing to map yet</h2>
            <p>Create a collection and add a few pages, and its shape will be here.</p>
            <p><a class="btn" href="#/">Back to collections</a></p></div>`}
      </div>`;
    return;
  }

  let collection = null;
  let raw;
  try {
    if (scope === 'all') {
      raw = await fetchWholeGraph();
    } else {
      [collection, raw] = await Promise.all([
        api('GET', `/collections/${scope}`),
        api('GET', `/collections/${scope}/graph`),
      ]);
    }
  } catch (err) {
    if (err.status === 404 || err.status === 405) {
      if (scope === 'all') {
        state.features.wholeGraph = false;
        location.replace('#/map');
        return;
      }
      state.features.map = false;
      const link = document.getElementById('nav-map');
      if (link) link.hidden = true;
      app.innerHTML = `<div class="page-wide">${mapUnavailableHTML()}</div>`;
      return;
    }
    throw err;
  }

  const graph = normalizeGraph(raw);
  // Collection names: the whole-record payload carries them; a single
  // collection's map knows its own.
  const collectionNames = new Map(graph.collections.map((c) => [c.id, c.name]));
  if (!collectionNames.size) {
    for (const c of list) collectionNames.set(c.id, c.name);
  }

  const keep = state.map && state.map.scope === scope ? state.map : null;
  // How many separate trees are on this map. Counted from the child edges
  // rather than from `rootId`, because only one of the two payloads carries
  // that field and both carry the edges.
  const hasParent = new Set(graph.edges.filter((e) => e.kind === 'child').map((e) => e.to));
  const rootCount = graph.nodes.filter(
    (n) => n.kind === 'page' && !n.external && !hasParent.has(n.id),
  ).length;
  // The list opens wherever a drawing could not name every node on it — see
  // MAP_LABELLED_CAP. Under that, the constellation is the default wherever
  // the shape is a web: the whole record, and any collection with more than
  // one tree in it. A single tree opens as a tree, because that is genuinely
  // the better reading of it.
  const defaultView = graph.nodes.length > MAP_LABELLED_CAP
    ? 'list'
    : scope === 'all' || rootCount > 1
      ? 'force'
      : 'tree';
  state.map = {
    scope,
    collectionId: scope === 'all' ? null : scope,
    collection,
    graph,
    collectionNames,
    filters: keep?.filters ?? {
      provenance: new Set(['authored', 'imported', 'federated']),
      status: new Set(['draft', 'in_review', 'canonical', 'needs_update', 'archived']),
      edges: new Set(MAP_EDGE_KINDS),
      collections: scope === 'all' ? new Set(collectionNames.keys()) : null,
    },
    view: keep?.view ?? defaultView,
    transform: { x: 0, y: 0, k: 1 },
    layout: null,
    layoutCache: null,
    revealed: null,
  };

  const total = graph.nodes.length;
  const whole = scope === 'all';
  const scopeOptions = [
    state.features.wholeGraph === true
      ? `<option value="all" ${whole ? 'selected' : ''}>Whole record</option>`
      : '',
    ...list.map((c) => `<option value="${esc(c.id)}" ${c.id === scope ? 'selected' : ''}>${esc(c.name)}</option>`),
  ].join('');

  app.innerHTML = `
    <div class="page-wide map-page">
      ${whole ? '' : `<p class="breadcrumb"><a href="#/collections/${esc(scope)}">${esc(collection?.name ?? scope)}</a></p>`}
      <div class="page-head">
        <div>
          <h1>Knowledge map</h1>
          <p class="muted map-lede">${whole
            ? `Every collection you can see, at once — <strong>${total} node${total === 1 ? '' : 's'}</strong> of it.`
            : `How <strong>${esc(collection?.name ?? scope)}</strong> hangs together, and where its material comes from.`}
            Every edge here is one Canon actually holds — the page tree, the links people wrote, the reference
            fields pages carry, and the conflicts and supersessions people asserted. Nothing is inferred, including
            the clusters: they are the collections and tree roots the record already has.</p>
        </div>
        <div class="actions">
          <div class="map-modes" role="group" aria-label="How to show the map">
            <button class="btn subtle" id="map-mode-force" aria-pressed="false"
              title="A seeded force layout, clustered by collection and tree root">Constellation</button>
            <button class="btn subtle" id="map-mode-tree" aria-pressed="false"
              title="The tidy layered tree — one column per depth">Tree</button>
            <button class="btn subtle" id="map-mode-list" aria-pressed="false"
              title="The same data as a nested list, which never stops being legible">List</button>
          </div>
          ${scopeOptions ? `
            <label class="map-scope"><span class="sr-only">What to map</span>
              <select id="map-collection">${scopeOptions}</select>
            </label>` : ''}
        </div>
      </div>

      ${mapTruncatedNotice(graph.truncated)}
      ${total > MAP_LABELLED_CAP ? `<div class="notice">${total} nodes is more than a drawing can name at once — past
        about ${MAP_LABELLED_CAP} the constellation shows the hubs' titles and leaves the rest as dots — so the
        <strong>list</strong> is what opens: the same nodes and the same edges, every title written out. The
        picture is one click away, and carries a key.</div>` : ''}

      ${mapFiltersHTML(graph, state.map.filters, collectionNames)}
      <p class="map-summary muted" id="map-summary"></p>
      <div class="map-stage" id="map-stage"></div>
      <div id="map-legend-host"></div>
    </div>`;

  app.querySelector('#map-collection')?.addEventListener('change', (e) => {
    location.hash = e.target.value === 'all' ? '#/map/all' : `#/collections/${encodeURIComponent(e.target.value)}/map`;
  });
  app.querySelector('#map-mode-force').addEventListener('click', () => setMapView('force'));
  app.querySelector('#map-mode-tree').addEventListener('click', () => setMapView('tree'));
  app.querySelector('#map-mode-list').addEventListener('click', () => setMapView('list'));
  app.querySelector('.map-filters').addEventListener('change', (e) => {
    const group = e.target?.dataset?.filter;
    if (!group || !state.map.filters[group]) return;
    const set = state.map.filters[group];
    if (e.target.checked) set.add(e.target.value);
    else set.delete(e.target.value);
    renderMapStage();
  });
  renderMapStage();
}

function setMapView(view) {
  if (!state.map) return;
  state.map.view = view;
  renderMapStage();
}

// The layout is expensive enough to be worth not repeating, and pure enough
// that caching it is safe: it depends on nothing but the nodes, the edges and
// the layout mode.
function mapLayoutFor(visible, mode) {
  const key = `${mode}|${visible.nodes.map((n) => n.id).join(',')}|${visible.edges.map((e) => `${e.kind}${e.from}>${e.to}`).join(',')}`;
  const cached = state.map.layoutCache;
  if (cached && cached.key === key) return cached.layout;
  const layout = mode === 'tree' ? mapTreeLayout(visible) : mapForceLayout(visible);
  state.map.layoutCache = { key, layout };
  return layout;
}

function renderMapStage() {
  const stage = document.getElementById('map-stage');
  const summary = document.getElementById('map-summary');
  if (!stage || !state.map) return;
  const { graph, filters, view, scope, collectionNames } = state.map;
  const visible = mapVisible(graph, filters);
  const pages = visible.nodes.filter((n) => n.kind === 'page').length;
  const sources = visible.nodes.length - pages;

  for (const mode of ['force', 'tree', 'list']) {
    const btn = document.getElementById(`map-mode-${mode}`);
    if (!btn) continue;
    btn.setAttribute('aria-pressed', String(view === mode));
    btn.classList.toggle('is-on', view === mode);
  }

  const palette = mapPalette(visible, scope);
  const legendHost = document.getElementById('map-legend-host');
  if (legendHost) legendHost.innerHTML = mapLegendHTML(palette, collectionNames, scope);

  if (summary) {
    const parts = [
      `${pages} page${pages === 1 ? '' : 's'}`,
      `${sources} source${sources === 1 ? '' : 's'}`,
      `${visible.edges.length} edge${visible.edges.length === 1 ? '' : 's'}`,
    ];
    const hidden = graph.nodes.length - visible.nodes.length;
    summary.innerHTML = `${esc(parts.join(' · '))}${hidden > 0 ? ` · <span class="muted">${hidden} hidden by the filters</span>` : ''}`;
  }

  if (!visible.nodes.length) {
    stage.className = 'map-stage is-empty';
    stage.innerHTML = `<div class="empty-state"><h2>Nothing matches these filters</h2>
      <p>Widen the filters above to bring the record back into view.</p></div>`;
    return;
  }

  if (view === 'list') {
    stage.className = 'map-stage is-list';
    stage.innerHTML = mapListHTML(visible, collectionNames, scope === 'all' && collectionNames.size > 1);
    return;
  }

  const layout = mapLayoutFor(visible, view);
  state.map.layout = layout;
  stage.className = `map-stage is-graph is-${layout.mode}`;
  stage.innerHTML = `
    <div class="map-controls">
      <button class="btn subtle" id="map-zoom-out" aria-label="Zoom out">−</button>
      <button class="btn subtle" id="map-zoom-in" aria-label="Zoom in">+</button>
      <button class="btn subtle" id="map-fit">Fit</button>
    </div>
    ${mapKeyHTML(palette, scope)}
    <div class="map-detail" id="map-detail" aria-live="polite"></div>
    ${layout.mode === 'tree' ? mapTreeSvgHTML(visible, layout) : mapForceSvgHTML(visible, layout, palette)}`;
  wireMapStage(visible, layout);
  stage.querySelector('#map-key-more')?.addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('map-legend-host')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // The settle-in reveal, played when the picture is new rather than on every
  // filter tick: the layout was already final before the first frame, so what
  // this animates is arrival, not physics.
  const revealKey = `${scope}|${view}`;
  if (state.map.revealed !== revealKey) {
    state.map.revealed = revealKey;
    const group = document.getElementById('map-nodes');
    const edgesG = stage.querySelector('.map-edges');
    if (group) {
      group.classList.add('is-revealing');
      edgesG?.classList.add('is-revealing');
      setTimeout(() => {
        group.classList.remove('is-revealing');
        edgesG?.classList.remove('is-revealing');
      }, 900);
    }
  }
}

function applyMapTransform() {
  const canvas = document.getElementById('map-canvas');
  if (!canvas || !state.map) return;
  const { x, y, k } = state.map.transform;
  canvas.setAttribute('transform', `translate(${x} ${y}) scale(${k})`);
  // Labels are tiered: the hubs are named at every zoom, and each step in
  // brings another band of names with it. A poster has no labels; a tool has
  // as many as it can show without becoming one.
  const svg = document.getElementById('map-svg');
  if (svg && state.map.layout?.mode === 'force') {
    const tier = k < 0.55 ? 0 : k < 0.95 ? 1 : k < 1.6 ? 2 : 3;
    if (svg.dataset.labels !== String(tier)) svg.dataset.labels = String(tier);
  }
}

function fitMap() {
  const svg = document.getElementById('map-svg');
  if (!svg || !state.map?.layout) return;
  const { width, height, mode } = state.map.layout;
  const w = svg.clientWidth || 900;
  const h = svg.clientHeight || 520;
  // The tree fits, but never below the zoom at which its label stops being a
  // label: past that, "fitting" fits a blur. The constellation has no such
  // floor — its labels are tiered, so zoomed out it still shows the hubs' names
  // and the true shape of the record.
  const floor = mode === 'tree' ? MAP_ZOOM_READABLE : MAP_ZOOM_MIN;
  const k = Math.min(MAP_ZOOM_MAX, Math.max(MAP_ZOOM_MIN, floor, Math.min(w / width, h / height, 1)));
  state.map.transform = {
    k,
    x: width * k <= w ? (w - width * k) / 2 : 0,
    y: height * k <= h ? (h - height * k) / 2 : 0,
  };
  applyMapTransform();
}

function mapDetailHTML(n, visible) {
  if (!n) {
    return `<p class="muted">Hover or tab to a node for its detail. Click one to open it.</p>`;
  }
  const degree = visible.degree.get(n.id) ?? 0;
  if (n.kind === 'source') {
    const readers = visible.edges.filter((e) => e.kind === 'reference' && e.to === n.id).length;
    return `
      <h3 class="map-detail-title">${esc(n.title)}</h3>
      <p class="map-detail-line"><span class="role-tag">${esc(n.type ?? 'source')}</span>
        ${n.authMode ? `<span class="kind-tag${n.authMode === 'service' ? ' ref-service' : ''}">${esc(n.authMode === 'service' ? 'service-resolved' : 'per asker')}</span>` : ''}</p>
      <p class="map-detail-line muted">An external system that still owns its facts. ${readers} page${readers === 1 ? '' : 's'} on this map read from it${n.freshnessWindowMs !== null ? `, fresh for ${esc(fmtDuration(n.freshnessWindowMs))}` : ''}.</p>`;
  }
  const links = visible.edges.filter((e) => e.kind === 'link' && e.from === n.id).length;
  const backlinks = visible.edges.filter((e) => e.kind === 'link' && e.to === n.id).length;
  const children = visible.edges.filter((e) => e.kind === 'child' && e.from === n.id).length;
  const parent = visible.parentOf.get(n.id);
  const parentNode = parent ? visible.byId.get(parent) : null;
  const collectionName = state.map?.collectionNames?.get(n.collectionId);
  return `
    <h3 class="map-detail-title">${esc(n.title)}</h3>
    <p class="map-detail-line">${badge(n.status, 'sm')}
      <span class="muted">${esc(TYPE_LABELS[n.type] ?? n.type ?? '')}</span>
      ${n.version ? `<span class="citation-version">v${esc(n.version)}</span>` : '<span class="muted">never published</span>'}
      ${n.external ? '<span class="map-external-tag">other collection</span>' : ''}</p>
    <p class="map-detail-line">${mapProvTag(n)}${collectionName && state.map?.scope === 'all'
      ? `<span class="role-tag">${esc(collectionName)}</span>` : ''}</p>
    ${n.origin ? `<p class="map-detail-line muted">Migrated from ${esc(n.origin.system)}${n.origin.file ? ` · ${esc(n.origin.file)}` : ''}${n.origin.at ? ` · ${esc(fmtDateTime(n.origin.at))}` : ''}. A migrated source should have been retired.</p>` : ''}
    ${n.references ? `<p class="map-detail-line muted">Reads ${n.references} value${n.references === 1 ? '' : 's'} from outside Canon.</p>` : ''}
    <p class="map-detail-line muted">${degree} connection${degree === 1 ? '' : 's'} here${parentNode ? ` · under ${esc(mapClip(parentNode.title, 22))}` : ''}${children ? ` · ${children} child${children === 1 ? '' : 'ren'}` : ''}</p>
    <p class="map-detail-line muted">${links} link${links === 1 ? '' : 's'} out · ${backlinks} in</p>`;
}

function wireMapStage(visible) {
  const svg = document.getElementById('map-svg');
  const detail = document.getElementById('map-detail');
  const nodesG = document.getElementById('map-nodes');
  if (!svg) return;
  fitMap();
  if (detail) detail.innerHTML = mapDetailHTML(null, visible);

  // Hovering lights a neighbourhood and dims the rest. Only the neighbourhood's
  // own classes are touched — the dimming is one class on the container — so
  // this stays a handful of DOM writes however many nodes are on the screen.
  const nodeEls = new Map();
  svg.querySelectorAll('.map-node').forEach((el) => nodeEls.set(el.dataset.node, el));
  const edgeEls = [...svg.querySelectorAll('.map-edge')];
  const edgesByNode = new Map();
  for (const el of edgeEls) {
    for (const id of [el.dataset.from, el.dataset.to]) {
      if (!edgesByNode.has(id)) edgesByNode.set(id, []);
      edgesByNode.get(id).push(el);
    }
  }
  let lit = [];
  const clear = () => {
    for (const el of lit) el.classList.remove('is-near', 'is-active');
    lit = [];
    svg.classList.remove('is-focusing');
  };
  const show = (id) => {
    clear();
    const node = nodeEls.get(id);
    if (detail) detail.innerHTML = mapDetailHTML(visible.byId.get(id) ?? null, visible);
    if (!node) return;
    svg.classList.add('is-focusing');
    node.classList.add('is-near', 'is-active');
    lit.push(node);
    for (const near of visible.neighbors.get(id) ?? []) {
      const el = nodeEls.get(near);
      if (!el) continue;
      el.classList.add('is-near');
      lit.push(el);
    }
    for (const el of edgesByNode.get(id) ?? []) {
      el.classList.add('is-near');
      lit.push(el);
    }
  };
  const over = (e) => {
    const node = e.target.closest?.('[data-node]');
    if (node) show(node.dataset.node);
  };
  svg.addEventListener('mouseover', over);
  svg.addEventListener('focusin', over);
  svg.addEventListener('mouseleave', () => {
    clear();
    if (detail) detail.innerHTML = mapDetailHTML(null, visible);
  });

  // Pan: drag anywhere that is not a node. A drag that moved is not a click,
  // so dragging across a node never navigates.
  let dragging = null;
  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest?.('a.map-node')) return;
    dragging = { x: e.clientX, y: e.clientY, ox: state.map.transform.x, oy: state.map.transform.y };
    svg.setPointerCapture(e.pointerId);
    svg.classList.add('is-panning');
  });
  svg.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    state.map.transform.x = dragging.ox + (e.clientX - dragging.x);
    state.map.transform.y = dragging.oy + (e.clientY - dragging.y);
    applyMapTransform();
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = null;
    svg.classList.remove('is-panning');
    try { svg.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);

  const zoomAbout = (factor, cx, cy) => {
    const t = state.map.transform;
    const k = Math.min(MAP_ZOOM_MAX, Math.max(MAP_ZOOM_MIN, t.k * factor));
    const ratio = k / t.k;
    state.map.transform = { k, x: cx - (cx - t.x) * ratio, y: cy - (cy - t.y) * ratio };
    applyMapTransform();
  };
  // Text is the one thing on this map that has to be re-rasterised on every
  // scale step, and at five hundred labels that is the whole cost of a wheel
  // zoom — measured: 34ms a frame with them, 17ms without. So a CONTINUOUS
  // zoom hides them for as long as the wheel is turning and brings them back
  // a beat after it stops; a single click of + or − changes scale once and
  // never needs it. Nothing is hidden at rest, which is when labels are read.
  let scaling = null;
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const box = svg.getBoundingClientRect();
    svg.classList.add('is-scaling');
    clearTimeout(scaling);
    scaling = setTimeout(() => svg.classList.remove('is-scaling'), 140);
    zoomAbout(Math.exp(-e.deltaY * 0.0015), e.clientX - box.left, e.clientY - box.top);
  }, { passive: false });

  const centre = () => [svg.clientWidth / 2, svg.clientHeight / 2];
  document.getElementById('map-zoom-in')?.addEventListener('click', () => zoomAbout(1.25, ...centre()));
  document.getElementById('map-zoom-out')?.addEventListener('click', () => zoomAbout(0.8, ...centre()));
  document.getElementById('map-fit')?.addEventListener('click', fitMap);

  // Keyboard: the arrows pan, +/- zoom, 0 fits. Every node is already a link
  // in the tab order, so Tab and Enter walk and open the record without a mouse.
  svg.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 160 : 60;
    const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[e.key]) {
      e.preventDefault();
      state.map.transform.x += moves[e.key][0];
      state.map.transform.y += moves[e.key][1];
      applyMapTransform();
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      zoomAbout(1.25, ...centre());
    } else if (e.key === '-') {
      e.preventDefault();
      zoomAbout(0.8, ...centre());
    } else if (e.key === '0') {
      e.preventDefault();
      fitMap();
    } else if (e.key === 'Escape') {
      clear();
      if (detail) detail.innerHTML = mapDetailHTML(null, visible);
    }
  });
  if (nodesG) nodesG.setAttribute('data-count', String(visible.nodes.length));
  // The layout is a pure function of the data, so a resize only re-fits it —
  // the picture itself never moves under the reader. One listener at a time,
  // and it no-ops once the map has been navigated away from.
  if (state.map.resize) window.removeEventListener('resize', state.map.resize);
  state.map.resize = () => { if (document.getElementById('map-svg')) fitMap(); };
  window.addEventListener('resize', state.map.resize);
}

// ---------------------------------------------------------------------------
// Attestation and export (FEATURES.md §7)
//
//   GET /pages/:id/as-of?at=<ISO>                  the point-in-time answer
//   GET /pages/:id/attestation[?at=][&format=html] the bundle for one page
//   GET /collections/:id/attestation[?at=][&format=html]   the register
//   GET /audit/verify                              walk the audit hash chain
//
// Feature-detected exactly as search, /ask, references and the map are: one
// probe, 404/405 means the endpoint is not built yet, and until it answers the
// affordance simply is not there.
//
// The probe is `GET /audit/verify?limit=1` — bounded to a single link, so it
// costs nothing on a large log; it has no side effect (unlike asking for an
// attestation, which is deliberately an audited act); and a 403 for somebody
// who is not an operator still proves the family shipped, which is what is
// being asked. It needs no page id, so the collection view can ask it too.

let attestationProbe = null;

async function detectAttestation() {
  if (state.features.attestation === null) {
    attestationProbe ??= api('GET', '/audit/verify?limit=1')
      .then(() => true)
      .catch((err) => (err.status === 404 || err.status === 405 ? false : err.status === 0 ? null : true));
    const found = await attestationProbe;
    attestationProbe = null;
    if (state.features.attestation === null && found !== null) state.features.attestation = found;
  }
  return state.features.attestation === true;
}

// Called by the page and collection views. Subject is { kind, id, title }.
async function renderAttestationAffordance(hostId, subject) {
  const host = document.getElementById(hostId);
  if (!host || !(await detectAttestation())) return;
  if (!host.isConnected) return; // the view re-rendered while the probe was in flight
  host.innerHTML = `<button class="btn subtle" id="${esc(hostId)}-btn"
    title="Prove the state of the record: what this said on a date, who had approved it, and the audit trail behind it"
    >Attestation</button>`;
  host.querySelector('button').addEventListener('click', () => openAttestationModal(subject));
}

// `datetime-local` wants "YYYY-MM-DDTHH:mm" in LOCAL time; the record speaks
// UTC. Both directions are here so the reader picks a moment in their own
// clock and the server is asked about the instant they meant.
function localInputValue(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function instantFromInput(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

// A file download that carries the caller's identity. `api()` cannot do this
// one: the HTML rendering is not JSON, and the response is an attachment whose
// filename the server chooses. Everything else — the headers, the cookie/dev
// distinction — is the same rule api() applies.
async function downloadFromApi(path, fallbackName) {
  const headers = {};
  const cookieSession = state.auth?.viaCookie === true;
  const actorId = cookieSession ? null : state.actor?.id;
  if (actorId) headers['X-Actor-Id'] = actorId;
  let res;
  try {
    res = await fetch(path, { headers, credentials: 'same-origin' });
  } catch {
    throw { status: 0, code: 'network', message: 'Cannot reach the Canon server.', details: {} };
  }
  if (!res.ok) {
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON error body */ }
    throw {
      status: res.status,
      code: data?.error ?? 'error',
      message: data?.message ?? `Request failed (${res.status})`,
      details: data ?? {},
    };
  }
  const disposition = res.headers.get('content-disposition') ?? '';
  const named = /filename="([^"]+)"/.exec(disposition);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = named ? named[1] : fallbackName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  // The response rides back so a caller can read what the server said ABOUT
  // the file — the audit export's truncation mark, for one — without a second
  // request. The body is spent; the headers are not.
  return res;
}

function attestationPreviewHTML(asOf) {
  if (!asOf) return '';
  if (!asOf.existed) {
    return `<div class="notice"><strong>Nothing to attest to.</strong> ${esc(asOf.answer)}</div>`;
  }
  const v = asOf.version;
  return `
    <div class="notice">${esc(asOf.answer)}</div>
    <dl class="field-block">
      <div><dt>Title then</dt><dd>${esc(asOf.title ?? '—')}</dd></div>
      <div><dt>Status then</dt><dd>${badge(asOf.status)}</dd></div>
      <div><dt>Canonical then</dt><dd>${asOf.canonical ? 'Yes' : 'No'}</dd></div>
      <div><dt>Version then</dt><dd>${v ? `v${esc(v.number)} · ${fmtDateTime(v.createdAt)} · ${actorLabel(v.authorId)}` : 'None published'}</dd></div>
      <div><dt>Approved by</dt><dd>${asOf.approval
        ? `${esc(actorName(asOf.approval.approverId))} · ${fmtDateTime(asOf.approval.at)}`
        : '<span class="muted">no approval covers the version standing then</span>'}</dd></div>
      ${asOf.fields?.ownerId ? `<div><dt>Owner then</dt><dd>${actorLabel(asOf.fields.ownerId)}</dd></div>` : ''}
      ${asOf.fields?.reviewDate ? `<div><dt>Review date then</dt><dd>${fmtDate(asOf.fields.reviewDate)}</dd></div>` : ''}
    </dl>`;
}

function registerPreviewHTML(bundle) {
  const rows = (bundle.register ?? []).slice(0, 12);
  if (!rows.length) {
    return '<div class="notice">No page in this collection held the Canonical mark at that moment.</div>';
  }
  return `
    <p class="muted">${esc(bundle.register.length)} Canonical, ${esc((bundle.notCanonical ?? []).length)} not.
    The full register is in the download.</p>
    <table class="table">
      <thead><tr><th>Page</th><th>Owner</th><th>Approver</th><th>Review due</th></tr></thead>
      <tbody>${rows.map((e) => `<tr>
        <td><a href="#/pages/${esc(e.pageId)}">${esc(e.title)}</a></td>
        <td>${esc(e.ownerName ?? '—')}</td>
        <td>${esc(e.approverName ?? '—')}</td>
        <td>${e.reviewDate ? fmtDate(e.reviewDate) : '—'}</td>
      </tr>`).join('')}</tbody>
    </table>`;
}

function openAttestationModal(subject) {
  const isPage = subject.kind === 'page';
  const base = isPage
    ? `/pages/${encodeURIComponent(subject.id)}`
    : `/collections/${encodeURIComponent(subject.id)}`;

  // The HTML rendering is the modal's own submit action — it is the one an
  // auditor is actually handed, so it is the primary button and the one the
  // Enter key reaches. JSON and Preview sit inside the body as secondary acts.
  const modal = openModal({
    title: isPage ? `Attestation — ${subject.title}` : `Register — ${subject.title}`,
    submitLabel: 'Download HTML',
    cancelLabel: 'Close',
    body: `
      <p class="muted">${isPage
        ? 'A self-contained record of this page: every published version with its author and note, every status change, the approvals, and the audit trail behind them — with the hash chain that makes the log tamper-evident.'
        : 'The register of pages that held the Canonical mark in this collection on a chosen date, with their owners, approvers and review dates.'}</p>
      <label>As at
        <input type="datetime-local" name="at" value="${esc(localInputValue())}">
      </label>
      <p class="muted">Your local time. Leave it at now for the current state.</p>
      <div class="modal-actions" style="justify-content:flex-start">
        <button type="button" class="btn" data-preview>Preview</button>
        <button type="button" class="btn" data-json>Download JSON</button>
      </div>
      <div data-attestation-preview></div>`,
    onSubmit: async (form) => {
      const instant = instantFromInput(form.at.value);
      const query = `?format=html${instant ? `&at=${encodeURIComponent(instant)}` : ''}`;
      await downloadFromApi(`${base}/attestation${query}`, 'canon-attestation.html');
      toast('Attestation downloaded. Open it in a browser and print to PDF.', 'ok');
    },
  });

  const root = document.getElementById('modal-root');
  const form = root.querySelector('form');
  const preview = root.querySelector('[data-attestation-preview]');
  const at = () => instantFromInput(form.at.value);

  const busy = async (button, work) => {
    button.disabled = true;
    try {
      await work();
    } catch (err) {
      // 404 here means the endpoint went away under us (a redeploy); the
      // affordance disappears rather than leaving a button that cannot work.
      if (err.status === 404 || err.status === 405) {
        state.features.attestation = false;
        modal.close();
        toast('Attestation is not available on this Canon.', 'info');
        return;
      }
      toastError(err);
    } finally {
      button.disabled = false;
    }
  };

  root.querySelector('[data-preview]').addEventListener('click', (e) => busy(e.target, async () => {
    const instant = at();
    if (!instant) { toast('That is not a date Canon can read.', 'error'); return; }
    preview.innerHTML = '<div class="loading">Reconstructing…</div>';
    const query = `?at=${encodeURIComponent(instant)}`;
    if (isPage) {
      const asOf = await api('GET', `${base}/as-of${query}`);
      preview.innerHTML = attestationPreviewHTML(asOf);
    } else {
      const bundle = await api('GET', `${base}/attestation${query}`);
      preview.innerHTML = registerPreviewHTML(bundle);
    }
  }));

  root.querySelector('[data-json]').addEventListener('click', (e) => busy(e.target, async () => {
    const instant = at();
    const query = instant ? `?at=${encodeURIComponent(instant)}` : '';
    await downloadFromApi(`${base}/attestation${query}`, 'canon-attestation.json');
    toast('Attestation downloaded. Generating one is itself on the audit log.', 'ok');
  }));
}

// ---------------------------------------------------------------------------
// Global wiring

// A tree branch opens and closes. This used to be the <details> element's job,
// and the handler here was the opposite one — intercepting a link click so
// navigating did not also collapse the branch it sat in. Two controls instead
// of one overloaded one means the link is now an ordinary link and needs
// nothing; only the toggle is wired, and it is delegated because the tree is
// re-rendered on every navigation.
document.addEventListener('click', (e) => {
  const toggle = e.target.closest?.('.tree-branch-toggle');
  if (!toggle) return;
  const kids = document.getElementById(toggle.getAttribute('aria-controls'));
  if (!kids) return;
  const open = toggle.getAttribute('aria-expanded') !== 'true';
  toggle.setAttribute('aria-expanded', String(open));
  kids.hidden = !open;
});

// Moving down a page without touching the address bar. Every "show me the rest
// of this" goes through here — a standing banner down to the conflicts
// register, the in-review empty state up to the diff — because `location.hash`
// IS the router and an `href="#panel"` navigates away from the page it is
// pointing into. Delegated from the document and registered once: it reaches
// panels that render after their view, and views that render many times over a
// session do not each leave a listener behind.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-scroll-to]');
  if (!btn) return;
  const target = document.getElementById(btn.dataset.scrollTo);
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// Refusals, everywhere, wired once (see `refusalGroup`). Delegated on the
// document rather than wired per screen for two reasons: the markup is
// self-describing — a greyed control points at its reason with
// `aria-describedby`, and a "Why?" points at its list with `aria-controls` —
// and a dialog's controls live in `#modal-root`, outside the app element every
// view renders into. Focus it, tap it, or click the "Why?": all three land here.
function revealRefusal(control) {
  const id = control.getAttribute('aria-describedby');
  const reason = id ? document.querySelector(`[id="${cssEscape(id)}"]`) : null;
  if (!reason) return;
  const list = reason.closest('.refusal-list');
  if (list?.hidden) {
    list.hidden = false;
    document.querySelector(`[aria-controls="${cssEscape(list.id)}"]`)?.setAttribute('aria-expanded', 'true');
  }
  (list ?? reason.parentElement)?.querySelectorAll('.is-lit').forEach((el) => el.classList.remove('is-lit'));
  reason.classList.add('is-lit');
}

document.addEventListener('click', (e) => {
  const toggle = e.target.closest?.('[data-refusal-toggle]');
  if (toggle) {
    const list = document.querySelector(`[id="${cssEscape(toggle.getAttribute('aria-controls'))}"]`);
    if (list) {
      list.hidden = !list.hidden;
      toggle.setAttribute('aria-expanded', String(!list.hidden));
    }
    return;
  }
  const control = e.target.closest?.('[data-refusal]');
  if (control) revealRefusal(control);
});
const onRefusalFocus = (e) => {
  const control = e.target.closest?.('[data-refusal]');
  if (control) revealRefusal(control);
};
// Both, deliberately. `focusin` bubbles and is the ordinary path; `focus`
// does not bubble, so it is taken in the capture phase, which is what fires
// when focus is moved programmatically or by a browser that is not the
// foreground window.
document.addEventListener('focusin', onRefusalFocus);
document.addEventListener('focus', onRefusalFocus, true);

window.addEventListener('hashchange', route);
// Ask the server which door is open before drawing anything: a cookie session
// means the person is already signed in and the chrome should say so.
loadAuth().finally(() => {
  renderChrome();
  wireSearch();
  wireSkipLink();
  wireNavToggle();
  route();
});
