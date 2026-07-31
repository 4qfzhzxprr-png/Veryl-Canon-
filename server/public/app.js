// Veryl Canon web UI — a single-file, no-dependency SPA over the Canon API.
// Identity is the dev X-Actor-Id header (SSO and Agent Passport arrive with
// the Registry integration). Hash routing; all rendering through esc() so no
// record content is ever injected as HTML.

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
const TYPE_FIELDS = {
  policy: { owner: true, approver: true, effectiveDate: true },
  spec: { owner: true, approver: true, effectiveDate: false },
  plan: { owner: true, approver: false, effectiveDate: false },
  note: { owner: false, approver: false, effectiveDate: false },
};
const REVIEWED_TYPES = ['policy', 'spec', 'plan'];

const STATUS_LABELS = { draft: 'Draft', in_review: 'In Review', canonical: 'Canonical', archived: 'Archived' };

const AUDIT_ACTIONS = [
  'collection.create', 'collection.member_set', 'collection.member_removed',
  'page.create', 'page.view', 'page.move', 'page.archive',
  'draft.start', 'draft.discard',
  'page.publish', 'page.submit', 'page.approve', 'page.send_back', 'page.restore',
];

const ROLES = ['view', 'comment', 'edit', 'approve', 'admin'];

// ---------------------------------------------------------------------------
// State

const state = {
  actor: readStoredActor(),
  actors: null, // cached GET /actors
  // null = not yet probed
  features: { search: null, comments: null, ask: null, related: null, references: null, sources: null },
  afterIdentity: null, // hash to return to after picking an identity
  ask: null, // last { question, collectionId, result } so back-navigation keeps it
  sourcesById: null, // cached GET /sources, keyed by id, for reference provenance
};

function resetFeatures() {
  state.features = { search: null, comments: null, ask: null, related: null, references: null, sources: null };
  askProbe = null;
  sourcesProbe = null;
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
  const actorId = opts.actorId ?? state.actor?.id;
  if (actorId) headers['X-Actor-Id'] = actorId;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
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

async function loadActors(force = false) {
  if (!state.actors || force) {
    state.actors = await api('GET', '/actors', undefined, state.actor ? {} : { actorId: 'onboarding' });
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
      <button class="btn subtle" id="switch-actor" title="Switch identity">Switch</button>`;
    chip.querySelector('#switch-actor').addEventListener('click', () => {
      storeActor(null);
      resetFeatures();
      state.ask = null;
      document.getElementById('search-slot').hidden = true;
      const askLink = document.getElementById('nav-ask');
      if (askLink) askLink.hidden = true;
      const sourcesLink = document.getElementById('nav-sources');
      if (sourcesLink) sourcesLink.hidden = true;
      renderChrome();
      location.hash = '#/identity';
      route();
    });
    detectSearch();
    detectAsk();
    detectSources();
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
  let actors = [];
  let loadError = null;
  try {
    actors = await api('GET', '/actors', undefined, { actorId: state.actor?.id ?? 'onboarding' });
  } catch (err) {
    loadError = err;
  }
  app.innerHTML = `
    <div class="identity-wrap">
      <div class="identity-card">
        <h1>Who are you?</h1>
        <p class="muted">Development sign-in for the Canon alpha. Identity travels as the
        <code>X-Actor-Id</code> header; SSO for people and Agent Passport authentication for
        agents arrive with the Registry integration.</p>
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
  renderAskAffordance('ask-affordance', collection.id);

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
        await api('DELETE', `/collections/${id}/members/${btn.dataset.removeMember}`);
        toast('Member removed.', 'ok');
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

  const actions = ['<span id="ask-affordance"></span>'];
  if (!isArchived && !inReview) actions.push(`<a class="btn" href="#/pages/${esc(id)}/edit">Edit</a>`);
  actions.push(`<a class="btn" href="#/pages/${esc(id)}/history">History</a>`);
  if (reviewed && page.status === 'draft' && draft) actions.push('<button class="btn primary" id="act-submit">Submit for review</button>');
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
        ${inReview ? `<div class="notice">In review. ${rules.approver ? `Waiting on the named approver, <strong>${esc(actorName(page.approverId))}</strong>.` : 'Waiting on an approver for this collection.'}</div>` : ''}

        <dl class="field-block">
          <div><dt>Type</dt><dd>${esc(TYPE_LABELS[page.type] ?? page.type)}</dd></div>
          <div><dt>Status</dt><dd>${badge(page.status)}</dd></div>
          ${rules.owner || page.ownerId ? `<div><dt>Owner</dt><dd>${actorLabel(page.ownerId)}</dd></div>` : ''}
          ${rules.approver || page.approverId ? `<div><dt>Approver</dt><dd>${actorLabel(page.approverId)}</dd></div>` : ''}
          ${rules.effectiveDate ? `<div><dt>Effective date</dt><dd>${fmtDate(page.effectiveDate)}</dd></div>` : ''}
          <div><dt>Version</dt><dd>${current ? `v${page.currentVersion} · published ${fmtDateTime(current.createdAt)} by ${esc(actorName(current.authorId))}` : 'Never published'}</dd></div>
          ${references.map(referencePlaceholderHTML).join('')}
        </dl>

        ${current ? `<article class="doc-body">${renderMarkdown(current.body)}</article>` : `
          <div class="empty-state">
            <h2>Nothing published yet</h2>
            <p>This page has no published version. ${isArchived ? '' : 'Open the editor to write the first draft, then publish it.'}</p>
            ${isArchived ? '' : `<p><a class="btn primary" href="#/pages/${esc(id)}/edit">Write the first draft</a></p>`}
          </div>`}

        <div id="related-host"></div>
        <div id="comments-host"></div>
      </section>
    </div>`;

  wireSidebar(collection, tree);
  renderAskAffordance('ask-affordance', page.collectionId);

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
  };
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
            ${!rules.owner && !rules.approver && !rules.effectiveDate ? '<p class="muted">A Note carries no required fields.</p>' : ''}
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
      <h1 class="doc-title">${esc(version.title)} ${badge(page.status)}</h1>
      <dl class="field-block">
        <div><dt>Type</dt><dd>${esc(TYPE_LABELS[page.type] ?? page.type)}</dd></div>
        ${version.fields.ownerId ? `<div><dt>Owner</dt><dd>${actorLabel(version.fields.ownerId)}</dd></div>` : ''}
        ${version.fields.approverId ? `<div><dt>Approver</dt><dd>${actorLabel(version.fields.approverId)}</dd></div>` : ''}
        ${version.fields.effectiveDate ? `<div><dt>Effective date</dt><dd>${fmtDate(version.fields.effectiveDate)}</dd></div>` : ''}
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
//     -> { answer: string|null, citations: [{ pageId, title, version, snippet }],
//          refused: boolean, reason?: "no_canonical_match" }
//
// Two things the UI has to carry, because they are the product's promises:
// every claim is verifiable by clicking through to the cited page and version,
// and a refusal is a correct answer about a silent record — never an error.

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

function citationsHTML(citations) {
  const items = citations.map((c) => {
    const head = `
      <span class="citation-num" aria-hidden="true">${c.n}</span>
      <span class="citation-main">
        <span class="citation-title-row">
          <span class="citation-title">${esc(c.title)}</span>
          ${badge(c.status ?? 'canonical', 'sm')}
          ${c.version ? `<span class="citation-version">v${esc(c.version)}</span>` : ''}
        </span>
        ${c.snippet ? `<span class="citation-snippet">${esc(c.snippet)}</span>` : ''}
      </span>`;
    const body = c.pageId
      ? `<a class="citation-link" href="#/pages/${esc(c.pageId)}">${head}<span class="citation-go" aria-hidden="true">→</span></a>`
      : `<div class="citation-link is-plain">${head}</div>`;
    const foot = c.pageId && c.version
      ? `<p class="citation-foot"><a href="#/pages/${esc(c.pageId)}/versions/${esc(c.version)}">Read v${esc(c.version)} exactly as cited</a></p>`
      : '';
    return `<li class="citation" data-citation="${c.n}">${body}${foot}</li>`;
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

function answerHTML(answer, citations) {
  const n = citations.length;
  return `
    <article class="answer">
      <div class="answer-head">
        <h2 class="h-small">Answer</h2>
        <span class="answer-grounding">drawn from ${n} Canonical page${n === 1 ? '' : 's'}</span>
      </div>
      <div class="answer-body">${linkifyCitationMarkers(renderMarkdown(answer), n)}</div>
    </article>
    ${citationsHTML(citations)}`;
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
          <p class="ask-grounding">Grounded in ${badge('canonical', 'sm')} pages only${collection ? `, within <strong>${esc(collection.name)}</strong>` : ''}.
            Drafts, Notes, and pages in review are never used.</p>
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
      resultHost.innerHTML = answerHTML(result.answer, citations);
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
renderChrome();
wireSearch();
route();
