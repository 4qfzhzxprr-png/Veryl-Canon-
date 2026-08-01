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

const AUDIT_ACTIONS = [
  'collection.create', 'collection.member_set', 'collection.member_removed',
  'page.create', 'page.view', 'page.move', 'page.archive',
  'draft.start', 'draft.discard',
  'page.publish', 'page.submit', 'page.approve', 'page.send_back', 'page.restore',
  'page.needs_update',
];

const ROLES = ['view', 'comment', 'edit', 'approve', 'admin'];

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
    relations: null, divergences: null,
  },
  afterIdentity: null, // hash to return to after picking an identity
  ask: null, // last { question, collectionId, result } so back-navigation keeps it
  sourcesById: null, // cached GET /sources, keyed by id, for reference provenance
};

function resetFeatures() {
  state.features = {
    search: null, comments: null, ask: null, related: null, references: null, sources: null,
    map: null, wholeGraph: null, attestation: null,
    relations: null, divergences: null,
  };
  askProbe = null;
  sourcesProbe = null;
  attestationProbe = null;
  mapProbe = null;
  wholeGraphProbe = null;
  wholeGraphCache = null;
  state.map = null;
  state.sourcesById = null;
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
  const a = actorById(id);
  return a ? a.name : id.slice(0, 8) + '…';
}

// ---------------------------------------------------------------------------
// Small helpers

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return esc(iso);
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
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

function badge(status, size = '') {
  const label = STATUS_LABELS[status] ?? status;
  return `<span class="badge badge-${esc(status)} ${size}">${esc(label)}</span>`;
}

function kindTag(kind) {
  return kind === 'agent' ? '<span class="kind-tag agent">agent</span>' : '<span class="kind-tag">person</span>';
}

function actorLabel(id) {
  const a = actorById(id);
  if (!a) return esc(actorName(id));
  return `${esc(a.name)}${a.kind === 'agent' ? ' <span class="kind-tag agent">agent</span>' : ''}`;
}

// ---------------------------------------------------------------------------
// Toasts

function toast(message, kind = 'error') {
  const host = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => { el.classList.add('leaving'); setTimeout(() => el.remove(), 300); }, 4500);
}

function toastError(err) {
  toast(err?.message ?? 'Something went wrong.', 'error');
}

// ---------------------------------------------------------------------------
// Modal — one at a time; onSubmit(form) may throw/reject to keep it open.

function openModal({ title, body, submitLabel = 'Save', cancelLabel = 'Cancel', danger = false, onSubmit }) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <h2>${esc(title)}</h2>
        <form>
          ${body}
          <div class="modal-actions">
            <button type="button" class="btn" data-cancel>${esc(cancelLabel)}</button>
            <button type="submit" class="btn ${danger ? 'danger' : 'primary'}">${esc(submitLabel)}</button>
          </div>
        </form>
      </div>
    </div>`;
  const backdrop = root.querySelector('.modal-backdrop');
  const form = root.querySelector('form');
  const close = () => { root.innerHTML = ''; };
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  root.querySelector('[data-cancel]').addEventListener('click', close);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = form.querySelector('button[type=submit]');
    submitBtn.disabled = true;
    try {
      await onSubmit(form);
      close();
    } catch (err) {
      submitBtn.disabled = false;
      toastError(err);
    }
  });
  const first = form.querySelector('input, textarea, select');
  if (first) first.focus();
  return { close };
}

// ---------------------------------------------------------------------------
// Markdown — a deliberately small, safe subset. Everything is HTML-escaped
// first; only markup this renderer generates ever reaches the DOM.

function renderMarkdown(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const isBlank = (l) => /^\s*$/.test(l);
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
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(`<li>${mdInline(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${mdInline(lines[i].replace(/^\s*\d+\.\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ol>${items.join('')}</ol>`);
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
    if (isBlank(line)) { i++; continue; }
    const buf = [];
    while (
      i < lines.length && !isBlank(lines[i]) &&
      !/^(#{1,6}\s|```|\s*[-*]\s|\s*\d+\.\s|\s*>)/.test(lines[i])
    ) {
      buf.push(mdInline(lines[i]));
      i++;
    }
    out.push(`<p>${buf.join(' ')}</p>`);
  }
  return out.join('\n');
}

function mdInline(raw) {
  let s = esc(raw);
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, href) => {
    // href is already entity-escaped; allow only benign schemes.
    if (/^(https?:|mailto:|#)/i.test(href)) {
      const external = /^https?:/i.test(href) ? ' target="_blank" rel="noopener noreferrer"' : '';
      return `<a href="${href}"${external}>${text}</a>`;
    }
    return text;
  });
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

// ---------------------------------------------------------------------------
// Chrome: top bar, identity chip, search (feature-detected)

function renderChrome() {
  const chip = document.getElementById('actor-chip');
  const nav = document.getElementById('topnav');
  if (state.actor) {
    nav.hidden = false;
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
      await loadAuth();
      renderChrome();
      location.hash = '#/identity';
      route();
    });
    detectSearch();
    detectAsk();
    detectSources();
    detectMap();
  } else {
    nav.hidden = true;
    chip.innerHTML = '';
  }
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

function wireSearch() {
  const input = document.getElementById('search-input');
  const results = document.getElementById('search-results');
  let timer = null;
  const hide = () => { results.hidden = true; };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { hide(); return; }
    timer = setTimeout(async () => {
      try {
        const r = await api('GET', `/search?q=${encodeURIComponent(q)}`);
        const items = Array.isArray(r) ? r : (r?.results ?? r?.pages ?? r?.hits ?? []);
        if (!items.length) {
          results.innerHTML = '<div class="search-empty">Nothing in the record matches.</div>';
        } else {
          results.innerHTML = items.slice(0, 12).map((it) => {
            const id = it.pageId ?? it.id;
            const title = it.title ?? '(untitled)';
            const status = it.status ? badge(it.status, 'sm') : '';
            const type = it.type ? `<span class="muted">${esc(TYPE_LABELS[it.type] ?? it.type)}</span>` : '';
            const snippet = it.snippet ?? it.excerpt ?? '';
            return `<a class="search-hit" href="#/pages/${esc(id)}">
              <span class="search-hit-title">${esc(title)}</span> ${status} ${type}
              ${snippet ? `<span class="search-snippet">${esc(snippet)}</span>` : ''}
            </a>`;
          }).join('');
        }
        results.hidden = false;
      } catch (err) {
        if (err.status === 404) { state.features.search = false; document.getElementById('search-slot').hidden = true; }
        else toastError(err);
      }
    }, 250);
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hide(); input.blur(); } });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-slot')) hide();
    if (e.target.closest('.search-hit')) { hide(); input.value = ''; }
  });
}

// ---------------------------------------------------------------------------
// Router

const app = document.getElementById('app');

function parseHash() {
  const h = location.hash.replace(/^#/, '');
  const parts = h.split('/').filter(Boolean).map(decodeURIComponent);
  return parts; // e.g. ['pages', id, 'edit']
}

async function route() {
  const parts = parseHash();
  if (!state.actor && parts[0] !== 'identity') {
    state.afterIdentity = location.hash || '#/';
    await render(viewIdentity);
    return;
  }
  const section = parts[0] === 'audit' ? 'audit'
    : parts[0] === 'ask' ? 'ask'
    : parts[0] === 'sources' ? 'sources'
    : 'home';
  document.querySelectorAll('#topnav a').forEach((a) => {
    a.classList.toggle('active', a.dataset.nav === section);
  });
  try {
    if (parts.length === 0) return await render(viewHome);
    if (parts[0] === 'identity') return await render(viewIdentity);
    if (parts[0] === 'audit') return await render(viewAudit);
    if (parts[0] === 'sources') return await render(viewSources);
    if (parts[0] === 'ask') return await render(() => viewAsk(parts[1] ?? null));
    if (parts[0] === 'map') return await render(() => viewMap(parts[1] ?? null));
    if (parts[0] === 'collections' && parts[1] && parts[2] === 'map') {
      return await render(() => viewMap(parts[1]));
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
}

function renderErrorPage(err) {
  const msg = err?.message ?? 'Something went wrong.';
  app.innerHTML = `
    <div class="page-narrow">
      <div class="empty-state">
        <h2>${err?.status === 403 ? 'No access' : err?.status === 404 ? 'Not found' : 'Something went wrong'}</h2>
        <p>${esc(msg)}</p>
        <p><a class="btn" href="#/">Back to collections</a></p>
      </div>
    </div>`;
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
              <h3>${esc(c.name)} ${c.restricted ? '<span class="restricted-tag" title="Views are logged to the audit log">restricted</span>' : ''}</h3>
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
      <label class="check"><input type="checkbox" name="restricted"> Restricted
        <span class="muted">page views are recorded in the audit log</span></label>`,
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
// Collection layout helpers (sidebar shared by collection + page views)

function flattenTree(nodes, depth = 0, out = []) {
  for (const n of nodes) {
    out.push({ ...n, depth });
    flattenTree(n.children, depth + 1, out);
  }
  return out;
}

function treeHTML(nodes, currentPageId) {
  if (!nodes.length) return '<p class="muted tree-empty">No pages yet.</p>';
  const item = (n) => {
    const active = n.id === currentPageId ? ' active' : '';
    const link = `<a class="tree-link${active}" href="#/pages/${esc(n.id)}">
      <span class="tree-title">${esc(n.title)}</span>${badge(n.status, 'sm')}</a>`;
    if (n.children.length) {
      return `<li><details open><summary>${link}</summary>${treeHTML(n.children, currentPageId)}</details></li>`;
    }
    return `<li class="leaf">${link}</li>`;
  };
  return `<ul class="tree">${nodes.map(item).join('')}</ul>`;
}

function sidebarHTML(collection, tree, currentPageId) {
  return `
    <aside class="sidebar">
      <a class="sidebar-collection" href="#/collections/${esc(collection.id)}">${esc(collection.name)}</a>
      ${collection.restricted ? '<span class="restricted-tag">restricted</span>' : ''}
      <button class="btn subtle sidebar-new" id="sidebar-new-page">+ New page</button>
      <nav class="tree-nav">${treeHTML(tree, currentPageId)}</nav>
    </aside>`;
}

function wireSidebar(collection, tree) {
  app.querySelector('#sidebar-new-page')?.addEventListener('click', () => openNewPageModal(collection, tree));
}

function openNewPageModal(collection, tree, presetParentId = null) {
  const flat = flattenTree(tree);
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
      <label>Parent page
        <select name="parentId">
          <option value="">(top level)</option>
          ${flat.map((n) => `<option value="${esc(n.id)}" ${n.id === presetParentId ? 'selected' : ''}>${'&nbsp;'.repeat(n.depth * 3)}${esc(n.title)}</option>`).join('')}
        </select>
      </label>`,
    onSubmit: async (form) => {
      const page = await api('POST', '/pages', {
        collectionId: collection.id,
        parentId: form.parentId.value || null,
        type: form.type.value,
        title: form.title.value.trim(),
      });
      toast(`Page "${page.title}" created as a ${TYPE_LABELS[page.type]}.`, 'ok');
      location.hash = `#/pages/${page.id}`;
    },
  });
  const form = document.querySelector('#modal-root form');
  form.type.addEventListener('change', () => {
    form.querySelector('[data-type-help]').textContent = TYPE_HELP[form.type.value];
  });
}

// ---------------------------------------------------------------------------
// Collection view

async function viewCollection(id) {
  const [collection, tree] = await Promise.all([
    api('GET', `/collections/${id}`),
    api('GET', `/collections/${id}/tree`),
  ]);
  await loadActors().catch(() => null);
  let members = [];
  try { members = await api('GET', `/collections/${id}/members`); } catch { /* view-only edge */ }

  app.innerHTML = `
    <div class="layout">
      ${sidebarHTML(collection, tree, null)}
      <section class="main">
        <div class="page-head">
          <div>
            <h1>${esc(collection.name)}
              ${collection.restricted ? '<span class="restricted-tag" title="Views are logged to the audit log">restricted</span>' : ''}</h1>
            <p class="muted">${esc(collection.description || 'No description.')}</p>
          </div>
          <div class="actions">
            <span id="attestation-affordance"></span>
            <span id="map-affordance"></span>
            <span id="ask-affordance"></span>
            <button class="btn primary" id="main-new-page">New page</button>
          </div>
        </div>

        ${tree.length ? '' : `
          <div class="empty-state">
            <h2>No pages yet</h2>
            <p>Pages are the unit of knowledge in Canon. Start with a Note for working
            material, or a Policy, Spec, or Plan when there is an owner ready to stand
            behind it.</p>
          </div>`}

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
                    <td class="t-right"><button class="btn subtle" data-remove-member="${esc(m.actorId)}">Remove</button></td>
                  </tr>`).join('')}
              </tbody>
            </table>` : '<p class="muted">Membership is not visible to you.</p>'}
          <form id="add-member-form" class="inline-form">
            <select name="actorId" required>
              <option value="">Add member…</option>
              ${(state.actors ?? []).filter((a) => !members.some((m) => m.actorId === a.id))
                .map((a) => `<option value="${esc(a.id)}">${esc(a.name)}${a.kind === 'agent' ? ' (agent)' : ''}</option>`).join('')}
            </select>
            <select name="role">
              ${ROLES.map((r) => `<option value="${r}" ${r === 'view' ? 'selected' : ''}>${r}</option>`).join('')}
            </select>
            <button class="btn" type="submit">Add</button>
          </form>
        </section>
      </section>
    </div>`;

  wireSidebar(collection, tree);
  app.querySelector('#main-new-page').addEventListener('click', () => openNewPageModal(collection, tree));
  renderMapAffordance('map-affordance', collection.id);
  renderAskAffordance('ask-affordance', collection.id);
  renderAttestationAffordance('attestation-affordance', {
    kind: 'collection',
    id: collection.id,
    title: collection.name,
  });

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

async function viewPage(id) {
  const page = await api('GET', `/pages/${id}`);
  const [collection, tree] = await Promise.all([
    api('GET', `/collections/${page.collectionId}`),
    api('GET', `/collections/${page.collectionId}/tree`),
    loadActors().catch(() => null),
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

  const draftBanner = draft ? `
    <div class="notice ${draft.editorId === state.actor.id ? 'notice-mine' : 'notice-locked'}">
      ${draft.editorId === state.actor.id
        ? `You have a draft in progress (last saved ${fmtDateTime(draft.updatedAt)}).
           <a class="btn subtle" href="#/pages/${esc(id)}/edit">Resume editing</a>`
        : `This page is being edited by <strong>${esc(actorName(draft.editorId))}</strong>. Canon keeps drafts to one editor at a time.`}
    </div>` : '';

  const actions = ['<span id="attestation-affordance"></span>', '<span id="ask-affordance"></span>'];
  if (!isArchived && !inReview) actions.push(`<a class="btn" href="#/pages/${esc(id)}/edit">Edit</a>`);
  actions.push(`<a class="btn" href="#/pages/${esc(id)}/history">History</a>`);
  // Needs Update submits like a Draft: the way back to Canonical is the review
  // workflow, not a separate re-certify button (FEATURES.md §3).
  if (reviewed && (page.status === 'draft' || page.status === 'needs_update') && draft) {
    actions.push('<button class="btn primary" id="act-submit">Submit for review</button>');
  }
  if (inReview) {
    actions.push('<button class="btn primary" id="act-approve">Approve</button>');
    actions.push('<button class="btn" id="act-sendback">Send back</button>');
  }
  if (!isArchived) actions.push('<button class="btn subtle" id="act-archive">Archive</button>');

  app.innerHTML = `
    <div class="layout">
      ${sidebarHTML(collection, tree, id)}
      <section class="main">
        <p class="breadcrumb"><a href="#/collections/${esc(collection.id)}">${esc(collection.name)}</a></p>
        <div class="page-head">
          <h1 class="doc-title">${esc(page.title)} ${badge(page.status)}</h1>
          <div class="actions">${actions.join('')}</div>
        </div>
        ${draftBanner}
        ${isArchived ? '<div class="notice">This page is archived and read-only. It is preserved with its full history.</div>' : ''}
        ${page.status === 'needs_update' ? `<div class="notice">Past review. Its review date (${fmtDate(page.reviewDate)}) has passed, so it is marked Needs Update. It is still the official record and can still be cited — edit it, set a new review date, and submit it for review to return it to Canonical.</div>` : ''}
        ${inReview ? `<div class="notice">In review. ${rules.approver ? `Waiting on the named approver, <strong>${esc(actorName(page.approverId))}</strong>.` : 'Waiting on an approver for this collection.'}</div>` : ''}

        <dl class="field-block">
          <div><dt>Type</dt><dd>${esc(TYPE_LABELS[page.type] ?? page.type)}</dd></div>
          <div><dt>Status</dt><dd>${badge(page.status)}</dd></div>
          ${rules.owner || page.ownerId ? `<div><dt>Owner</dt><dd>${actorLabel(page.ownerId)}</dd></div>` : ''}
          ${rules.approver || page.approverId ? `<div><dt>Approver</dt><dd>${actorLabel(page.approverId)}</dd></div>` : ''}
          ${rules.effectiveDate ? `<div><dt>Effective date</dt><dd>${fmtDate(page.effectiveDate)}</dd></div>` : ''}
          ${rules.reviewDate || page.reviewDate ? `<div><dt>Review date</dt><dd>${fmtDate(page.reviewDate)}${page.status === 'needs_update' ? ' · <span class="muted">past review</span>' : ''}</dd></div>` : ''}
          <div><dt>Version</dt><dd>${current ? `v${page.currentVersion} · published ${fmtDateTime(current.createdAt)} by ${esc(actorName(current.authorId))}` : 'Never published'}</dd></div>
          ${references.map(referencePlaceholderHTML).join('')}
        </dl>

        ${current ? `<article class="doc-body">${renderMarkdown(current.body)}</article>` : `
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
  renderAskAffordance('ask-affordance', page.collectionId);
  renderAttestationAffordance('attestation-affordance', { kind: 'page', id, title: page.title });

  app.querySelector('#act-submit')?.addEventListener('click', async () => {
    try {
      await api('POST', `/pages/${id}/submit`);
      toast('Submitted for review.', 'ok');
      route();
    } catch (err) { toastError(err); }
  });
  app.querySelector('#act-approve')?.addEventListener('click', () => openModal({
    title: 'Approve as Canonical',
    submitLabel: 'Approve',
    body: `
      <p class="muted">Approving publishes the reviewed draft and grants the Canonical mark.</p>
      <label>Note <input name="note" placeholder="optional, kept in version history"></label>`,
    onSubmit: async (form) => {
      await api('POST', `/pages/${id}/approve`, form.note.value.trim() ? { note: form.note.value.trim() } : {});
      toast('Approved. This page is now Canonical.', 'ok');
      route();
    },
  }));
  app.querySelector('#act-sendback')?.addEventListener('click', () => openModal({
    title: 'Send back to the author',
    submitLabel: 'Send back',
    body: `
      <p class="muted">The page returns to Draft. Your comment goes to the author.</p>
      <label>Comment <textarea name="comment" rows="3" required placeholder="What needs to change before this can be Canonical?"></textarea></label>`,
    onSubmit: async (form) => {
      await api('POST', `/pages/${id}/send-back`, { comment: form.comment.value.trim() });
      toast('Sent back with your comment.', 'ok');
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

  renderReferences(id, references);
  // Where the record disagrees with itself (DATA-BACKBONE.md §7). Two separate
  // pieces of server, feature-detected separately: neither one's absence hides
  // the other, and a Canon that serves neither shows a page exactly as before.
  renderDivergencesPanel(id);
  renderRelationsPanel(id, page);
  renderRelatedPanel(id);
  renderCommentsPanel(id);
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
  return referenceRowHTML({
    r,
    cls: 'is-resolving',
    valueHTML: '<span class="skel-line ref-skel-value" aria-hidden="true"></span>'
      + '<span class="sr-only">Resolving this value from its source…</span>',
    marks: service ? [serviceMarkHTML()] : [],
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
  return referenceRowHTML({
    r,
    cls: 'is-error',
    valueHTML: '<span class="ref-value is-unresolved">Not resolved</span>',
    marks: [
      '<span class="badge badge-unresolved sm">unresolved</span>',
      ...(service ? [serviceMarkHTML()] : []),
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
  return {
    id: r?.id ?? null,
    kind,
    reads,
    note: r?.note ?? null,
    assertedBy: r?.assertedBy ?? null,
    assertedAt: r?.assertedAt ?? null,
    other: {
      id: other.id ?? r?.otherPageId ?? null,
      title: other.title ?? '(untitled page)',
      status: other.status ?? null,
      type: other.type ?? null,
    },
  };
}

function relationEntryHTML(rel) {
  return `
    <li class="relation rel-${esc(rel.reads)}"${rel.id ? ` data-relation="${esc(rel.id)}"` : ''}>
      <div class="rel-head">
        <span class="rel-kind" title="${esc(RELATION_READ_HELP[rel.reads])}">${esc(RELATION_READ_LABELS[rel.reads])}</span>
        ${rel.other.id
          ? `<a class="rel-target" href="#/pages/${esc(rel.other.id)}">${esc(rel.other.title)}</a>`
          : `<span class="rel-target">${esc(rel.other.title)}</span>`}
        ${rel.other.status ? badge(rel.other.status, 'sm') : ''}
      </div>
      ${rel.note ? `<p class="rel-note">${esc(rel.note)}</p>` : `
        <p class="rel-note muted">No note was recorded with this assertion.</p>`}
      <p class="rel-meta muted">Asserted by ${actorLabel(rel.assertedBy)}${
        rel.assertedAt ? ` · ${esc(fmtAgo(rel.assertedAt) ?? '')} (${esc(fmtDateTime(rel.assertedAt))})` : ''
      }${rel.id ? ` · <button class="btn subtle rel-withdraw" type="button" data-withdraw="${esc(rel.id)}">Withdraw</button>` : ''}</p>
    </li>`;
}

async function renderRelationsPanel(pageId, page) {
  const host = document.getElementById('relations-host');
  if (!host || state.features.relations === false) return;
  let rows;
  try {
    const r = await api('GET', `/pages/${pageId}/relations`);
    state.features.relations = true;
    rows = (Array.isArray(r) ? r : (r?.relations ?? [])).map(normalizeRelation);
  } catch (err) {
    if (err.status === 404 || err.status === 405) { state.features.relations = false; return; }
    return; // a read that failed is not a claim that there are none
  }
  if (!host.isConnected) return;

  const archived = page?.status === 'archived';
  host.innerHTML = `
    <section class="panel relations ${rows.some((r) => r.reads === 'conflicts_with') ? 'has-conflict' : ''}" id="relations-panel">
      <div class="rel-panel-head">
        <h2 class="h-small">Conflicts and supersessions</h2>
        ${archived ? '' : '<button class="btn subtle" type="button" id="rel-assert">Assert a relation…</button>'}
      </div>
      <p class="rel-lede">Explicit relations between pages, written down by a person. Canon draws a contradiction
        rather than deciding it: nothing here changes what either page says, the standing it holds, or whether it can
        be cited.</p>
      ${rows.length
        ? `<ul class="rel-list">${rows.map(relationEntryHTML).join('')}</ul>`
        : '<p class="muted rel-empty">The record does not hold a conflict or a supersession for this page.</p>'}
    </section>`;

  host.querySelector('#rel-assert')?.addEventListener('click', () => openRelationModal(pageId, page));
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
        renderRelationsPanel(pageId, page);
      },
    }));
  });
}

// Asserting one. The other page is chosen through the search the record
// already has; where search is not served, its id is typed in, because a
// relation names a page and a page has an id.
function openRelationModal(pageId, page) {
  const searchable = state.features.search === true;
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
      renderRelationsPanel(pageId, page);
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
      picks.innerHTML = items.length
        ? items.map((it) => `<button type="button" class="rel-pick" data-id="${esc(it.pageId ?? it.id)}"
            data-title="${esc(it.title ?? '(untitled)')}">${esc(it.title ?? '(untitled)')}
            ${it.status ? badge(it.status, 'sm') : ''}</button>`).join('')
        : '<p class="muted rel-pick-empty">Nothing in the record matches.</p>';
      picks.hidden = false;
      picks.querySelectorAll('.rel-pick').forEach((btn) => {
        btn.addEventListener('click', () => {
          hidden.value = btn.dataset.id;
          chosen.textContent = `Chosen: ${btn.dataset.title}`;
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
    resolved: c.resolved ?? c.resolvedAt ?? false,
  };
}

async function renderCommentsPanel(pageId) {
  const host = document.getElementById('comments-host');
  if (!host || state.features.comments === false) return;
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
  host.innerHTML = `
    <section class="panel" id="comments-panel">
      <h2 class="h-small">Comments</h2>
      ${comments.length ? `
        <ul class="comment-list">
          ${comments.map((c) => `
            <li class="comment ${c.resolved ? 'resolved' : ''}">
              <div class="comment-meta">${actorLabel(c.authorId)}
                <span class="muted">${fmtDateTime(c.createdAt)}</span>
                ${c.resolved ? '<span class="role-tag">resolved</span>' : ''}</div>
              <div class="comment-body">${esc(c.body)}</div>
            </li>`).join('')}
        </ul>` : '<p class="muted">No comments yet.</p>'}
      <form id="comment-form" class="stack">
        <textarea name="body" rows="2" required placeholder="Add a comment…"></textarea>
        <div><button class="btn" type="submit">Comment</button></div>
      </form>
    </section>`;
  host.querySelector('#comment-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = e.target.body.value.trim();
    if (!body) return;
    try {
      await api('POST', `/pages/${pageId}/comments`, { body });
      renderCommentsPanel(pageId);
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

async function viewEditor(id) {
  const page = await api('GET', `/pages/${id}`);
  await loadActors().catch(() => null);
  let draft;
  try {
    draft = await api('PUT', `/pages/${id}/draft`, {}); // acquires the page lock
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

  app.innerHTML = `
    <div class="page-wide editor">
      <p class="breadcrumb"><a href="#/pages/${esc(id)}">← Back to page</a></p>
      <div class="page-head">
        <h1>Editing <span class="muted">(${esc(TYPE_LABELS[page.type])})</span></h1>
        <span id="save-state" class="muted"></span>
      </div>
      ${page.status === 'canonical' ? `
        <div class="notice">This page is Canonical. Publishing new content returns it to Draft —
        the Canonical mark applies to reviewed content and is granted again through review.</div>` : ''}
      <form id="editor-form" class="editor-grid">
        <div class="editor-mainCol">
          <label>Title <input name="title" required maxlength="200" value="${esc(draft.title)}"></label>
          <label>Body
            <textarea name="body" class="editor-body" spellcheck="true">${esc(draft.body)}</textarea>
          </label>
          <p class="muted md-hint">Markdown subset: <code># headings</code>, <code>**bold**</code>,
            <code>*italic*</code>, <code>- lists</code>, <code>1. lists</code>, <code>\`code\`</code>,
            fenced blocks, <code>[links](https://…)</code>, <code>&gt; quotes</code>.</p>
        </div>
        <div class="editor-sideCol">
          <div class="panel">
            <h2 class="h-small">Fields</h2>
            ${rules.owner ? `<label>Owner <select name="ownerId">${actorOptions(draft.fields.ownerId)}</select></label>` : ''}
            ${rules.approver ? `<label>Approver <select name="approverId">${actorOptions(draft.fields.approverId)}</select></label>` : ''}
            ${rules.effectiveDate ? `<label>Effective date <input type="date" name="effectiveDate" value="${esc(draft.fields.effectiveDate ?? '')}"></label>` : ''}
            ${rules.reviewDate ? `<label>Review date${rules.reviewDateRequired ? ' <span class="muted">(required)</span>' : ''} <input type="date" name="reviewDate" value="${esc(draft.fields.reviewDate ?? '')}"></label>
            <p class="muted">When this date passes, the page flips to Needs Update and its owner is notified.</p>` : ''}
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

  const gather = () => {
    const fields = {};
    if (rules.owner) fields.ownerId = form.ownerId.value || null;
    if (rules.approver) fields.approverId = form.approverId.value || null;
    if (rules.effectiveDate) fields.effectiveDate = form.effectiveDate.value || null;
    if (rules.reviewDate) fields.reviewDate = form.reviewDate.value || null;
    return { title: form.title.value.trim(), body: form.body.value, fields };
  };

  const save = async () => {
    const d = await api('PUT', `/pages/${id}/draft`, gather());
    saveState.textContent = `Draft saved ${fmtDateTime(d.updatedAt)}`;
    return d;
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await save(); toast('Draft saved.', 'ok'); } catch (err) { handleEditError(err); }
  });

  app.querySelector('#ed-publish').addEventListener('click', async () => {
    openModal({
      title: 'Publish this draft',
      submitLabel: 'Publish',
      body: `
        <p class="muted">Publishing makes this draft the current version for every reader.
        ${reviewed ? 'It publishes without review — use "Submit for review" if this page should earn the Canonical mark.' : ''}</p>
        <label>Version note <input name="note" placeholder="optional, kept in version history"></label>`,
      onSubmit: async (mform) => {
        await save();
        await api('POST', `/pages/${id}/publish`, mform.note.value.trim() ? { note: mform.note.value.trim() } : {});
        toast('Published.', 'ok');
        location.hash = `#/pages/${id}`;
      },
    });
  });

  app.querySelector('#ed-submit')?.addEventListener('click', async () => {
    try {
      await save();
      await api('POST', `/pages/${id}/submit`);
      toast('Submitted for review.', 'ok');
      location.hash = `#/pages/${id}`;
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

  function handleEditError(err) {
    if (err.status === 423) {
      const editor = err.details?.editorName ?? 'someone else';
      toast(`This page is being edited by ${editor}.`, 'error');
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

async function viewHistory(id) {
  const [page, versions] = await Promise.all([
    api('GET', `/pages/${id}`),
    api('GET', `/pages/${id}/versions`),
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
      ${versions.length ? `
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
        </table>` : `
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
        published ${fmtDateTime(version.createdAt)} by ${esc(actorName(version.authorId))}.
        ${isCurrent ? 'This is the current version.' : `The current version is v${page.currentVersion ?? '—'}.
          ${page.status !== 'archived' ? `<button class="btn subtle" id="restore-here">Restore this version</button>` : ''}`}
      </div>
      <h1 class="doc-title">${esc(version.title)} ${versionStanding(page, isCurrent)}</h1>
      <dl class="field-block">
        <div><dt>Type</dt><dd>${esc(TYPE_LABELS[page.type] ?? page.type)}</dd></div>
        ${version.fields.ownerId ? `<div><dt>Owner</dt><dd>${actorLabel(version.fields.ownerId)}</dd></div>` : ''}
        ${version.fields.approverId ? `<div><dt>Approver</dt><dd>${actorLabel(version.fields.approverId)}</dd></div>` : ''}
        ${version.fields.effectiveDate ? `<div><dt>Effective date</dt><dd>${fmtDate(version.fields.effectiveDate)}</dd></div>` : ''}
        ${version.fields.reviewDate ? `<div><dt>Review date</dt><dd>${fmtDate(version.fields.reviewDate)}</dd></div>` : ''}
        ${version.note ? `<div><dt>Version note</dt><dd>${esc(version.note)}</dd></div>` : ''}
      </dl>
      <article class="doc-body">${renderMarkdown(version.body)}</article>
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
  const changed = rows.filter((r) => r.type !== 'same').length;
  const cell = (text, cls) => `<td class="diff-cell ${cls}">${text === undefined ? '' : `<span>${esc(text) || '&nbsp;'}</span>`}</td>`;
  app.innerHTML = `
    <div class="page-wide">
      <p class="breadcrumb"><a href="#/pages/${esc(id)}/history">← Version history</a></p>
      <div class="page-head">
        <h1>Compare <span class="muted">${esc(page.title)}</span></h1>
      </div>
      ${va.title !== vb.title ? `<p class="notice">Title changed:
        <del>${esc(va.title)}</del> → <ins>${esc(vb.title)}</ins></p>` : ''}
      <p class="muted">${changed ? `${changed} changed line${changed === 1 ? '' : 's'}.` : 'The two versions have identical bodies.'}</p>
      <div class="diff-scroll">
        <table class="diff-table">
          <thead>
            <tr>
              <th>v${a} · ${fmtDateTime(va.createdAt)} · ${esc(actorName(va.authorId))}</th>
              <th>v${b} · ${fmtDateTime(vb.createdAt)} · ${esc(actorName(vb.authorId))}</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((r) => {
              if (r.type === 'same') return `<tr>${cell(r.a, '')}${cell(r.b, '')}</tr>`;
              if (r.type === 'del') return `<tr>${cell(r.a, 'del')}${cell(undefined, 'void')}</tr>`;
              return `<tr>${cell(undefined, 'void')}${cell(r.b, 'add')}</tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Audit view

async function viewAudit() {
  await loadActors().catch(() => null);
  app.innerHTML = `
    <div class="page-wide">
      <div class="page-head"><h1>Audit log</h1></div>
      <p class="muted">Append-only. Every write, workflow step, and view of restricted
      material, attributed to its actor.</p>
      <form id="audit-filters" class="inline-form">
        <label>Action
          <select name="action">
            <option value="">All actions</option>
            ${AUDIT_ACTIONS.map((a) => `<option value="${a}">${a}</option>`).join('')}
          </select>
        </label>
        <label>Actor
          <select name="actor">
            <option value="">All actors</option>
            ${(state.actors ?? []).map((a) => `<option value="${esc(a.id)}">${esc(a.name)}${a.kind === 'agent' ? ' (agent)' : ''}</option>`).join('')}
          </select>
        </label>
      </form>
      <div id="audit-table"><div class="loading">Loading…</div></div>
    </div>`;

  const form = app.querySelector('#audit-filters');
  const tableHost = app.querySelector('#audit-table');

  const load = async () => {
    tableHost.innerHTML = '<div class="loading">Loading…</div>';
    const params = new URLSearchParams();
    if (form.action.value) params.set('action', form.action.value);
    if (form.actor.value) params.set('actor', form.actor.value);
    try {
      const events = await api('GET', `/audit${params.toString() ? `?${params}` : ''}`);
      if (!events.length) {
        tableHost.innerHTML = `
          <div class="empty-state"><h2>No matching events</h2>
          <p>Nothing in the log matches these filters yet.</p></div>`;
        return;
      }
      tableHost.innerHTML = `
        <table class="table audit">
          <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Where</th><th>Details</th></tr></thead>
          <tbody>
            ${events.map((e) => {
              const details = Object.entries(e.details ?? {})
                .map(([k, v]) => `<span class="detail-kv"><span class="muted">${esc(k)}:</span> ${esc(typeof v === 'object' ? JSON.stringify(v) : String(v))}</span>`)
                .join(' ');
              return `<tr>
                <td class="nowrap">${fmtDateTime(e.at)}</td>
                <td>${esc(actorName(e.actorId))} ${e.actorKind === 'agent' ? '<span class="kind-tag agent">agent</span>' : ''}</td>
                <td><code class="action-code">${esc(e.action)}</code></td>
                <td>${e.pageId ? `<a href="#/pages/${esc(e.pageId)}">page</a>` : e.collectionId ? `<a href="#/collections/${esc(e.collectionId)}">collection</a>` : '<span class="muted">—</span>'}</td>
                <td class="audit-details">${details || '<span class="muted">—</span>'}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>`;
    } catch (err) {
      tableHost.innerHTML = `<div class="empty-state"><h2>Could not load the log</h2><p>${esc(err.message)}</p></div>`;
    }
  };

  form.action.addEventListener('change', load);
  form.actor.addEventListener('change', load);
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
          ${collections.map((c) => `<option value="${esc(c.id)}" ${scope.includes(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select>
      </label>
      <p class="muted type-help">Select none to leave it Canon-wide — every collection may reference
        it. Selecting collections limits it to those, and a page anywhere else cannot ask this
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

  app.innerHTML = `
    <div class="page-wide">
      <div class="page-head">
        <div>
          <h1>Sources</h1>
          <p class="muted sources-lede">External systems Canon reads from and never copies. A page
            holds a reference — the key to ask with — and the value is resolved when the page is
            read, shown with the source that answered and the time it answered.</p>
        </div>
        <div class="actions"><button class="btn primary" id="new-source">Register a source</button></div>
      </div>

      ${sources.length ? `
        <div class="table-scroll"><table class="table sources-table">
          <thead><tr><th>Name</th><th>Kind</th><th>Resolved as</th><th>Referenceable from</th><th>Freshness window</th><th></th></tr></thead>
          <tbody>
            ${sources.map((s) => `
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
                  <button class="btn subtle" data-edit-source="${esc(s.id)}">Edit</button>
                  <button class="btn subtle" data-delete-source="${esc(s.id)}">Delete</button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table></div>` : `
        <div class="empty-state">
          <h2>No sources registered</h2>
          <p>Register the system that owns a fact — the HRIS for headcount, the benefits
            administrator for a deductible — and pages can reference its values instead of
            asserting numbers Canon does not own and cannot keep true.</p>
          <p><button class="btn primary" id="new-source-empty">Register the first source</button></p>
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
// `canonical`, or `needs_update` when it is past its review date. It is the
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
          ${disputed.has(c.pageId)
            ? '<span class="citation-disputed" title="This page is one of the two the record answers differently from. Both are cited; neither has been chosen.">in disagreement</span>'
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
    return `<li class="citation ${disputed.has(c.pageId) ? 'is-disputed' : ''}" data-citation="${c.n}">${body}${foot}</li>`;
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
  return `
    ${disagreement ? disagreementHTML(disagreement) : ''}
    <article class="answer ${disagreement ? 'is-contested' : ''}">
      <div class="answer-head">
        <h2 class="h-small">Answer</h2>
        <span class="answer-grounding">drawn from ${n} Canonical page${n === 1 ? '' : 's'}${staleNote}${
          disagreement ? ', which do not agree' : ''
        }</span>
      </div>
      <div class="answer-body">${linkifyCitationMarkers(renderMarkdown(answer), n)}</div>
    </article>
    ${citationsHTML(citations, disputed)}`;
}

function refusalHTML(result, question, collection) {
  const known = !result.reason || result.reason === 'no_canonical_match';
  return `
    <section class="refusal">
      <h2>The record does not answer this yet.</h2>
      <p>Nothing Canonical${collection ? ` in <strong>${esc(collection.name)}</strong>` : ''}
        covers ${question ? `&ldquo;${esc(question)}&rdquo;` : 'this question'}. Canon says so rather
        than assembling an answer it cannot cite — a confident guess is the one thing a
        knowledge record must never produce.</p>
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
      box.value = question;
      box.dispatchEvent(new Event('input'));
      box.focus();
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
// as a nested list on demand, and by default past MAP_GRAPH_CAP nodes.

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
// Past this many nodes the picture stops being legible at any zoom that still
// shows a label, so the list — which never stops being legible — is what a
// reader gets unless they ask for the drawing. The constellation raised this a
// long way above what the column layout could carry.
const MAP_GRAPH_CAP = 600;

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
  conflicts_with: 'A person asserted that these two pages contradict each other, and said how. Canon surfaces the contradiction; it never resolves it — no merge, no precedence, no quiet winner.',
  supersedes: 'A person asserted that one page replaces another. The superseded page keeps its standing and its history: saying so archives nothing.',
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
//             deliberately so: at the sizes this map draws (the list takes over
//             past MAP_GRAPH_CAP) a Barnes–Hut tree costs more to build than the
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
  document.querySelectorAll('#topnav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === 'map'));

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
  const defaultView = graph.nodes.length > MAP_GRAPH_CAP
    ? 'list'
    // The constellation is the default wherever the shape is a web: the whole
    // record, and any collection with more than one tree in it. A single tree
    // opens as a tree, because that is genuinely the better reading of it.
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
      ${total > MAP_GRAPH_CAP ? `<div class="notice">${total} nodes is more than a drawing can show legibly, so the
        list is what opens by default. The picture is still one click away.</div>` : ''}

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
    <div class="map-detail" id="map-detail" aria-live="polite"></div>
    ${layout.mode === 'tree' ? mapTreeSvgHTML(visible, layout) : mapForceSvgHTML(visible, layout, palette)}`;
  wireMapStage(visible, layout);

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
      <div><dt>Version then</dt><dd>${v ? `v${esc(v.number)} · ${fmtDateTime(v.createdAt)} · ${esc(actorName(v.authorId))}` : 'None published'}</dd></div>
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

// Tree links live inside <summary>; navigate without toggling the branch.
document.addEventListener('click', (e) => {
  const link = e.target.closest('summary a.tree-link');
  if (link) {
    e.preventDefault();
    location.hash = link.getAttribute('href');
  }
});

window.addEventListener('hashchange', route);
// Ask the server which door is open before drawing anything: a cookie session
// means the person is already signed in and the chrome should say so.
loadAuth().finally(() => {
  renderChrome();
  wireSearch();
  route();
});
