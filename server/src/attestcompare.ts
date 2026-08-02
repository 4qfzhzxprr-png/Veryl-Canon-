import { chainHash } from './auditchain.js';
import { contentDigest } from './attestation.js';
import { CanonError } from './model.js';

// Comparing two attestations somebody kept — the check that survives an
// attacker who can write to Canon's database.
//
// ---------------------------------------------------------------------------
// WHY THIS IS THE MOST VALUABLE THING IN THE EVIDENCE STORY
//
// USER-TESTING.md T3.2, in the auditor's own order.
//
//   Her naive tamper — an UPDATE against `audit_events` — was refused outright
//   by the append-only triggers. She dropped the triggers and forced the edit,
//   and `GET /audit/verify` caught it precisely: content_mismatch, event 726.
//
//   Her competent forgery — delete the `page.submit` event, reattribute the
//   approval to the author, then RECOMPUTE all 1,171 chain links — returned
//   `ok: true, firstBreak: null`, and a fresh attestation generated afterwards
//   asserted that the author had granted the Canonical mark to their own page.
//   The chain was flawless. It was flawless about a lie.
//
//   Her counter-test: she compared the attestation she had KEPT from before the
//   forgery against one generated after it, and it named the forgery exactly —
//   event 724 missing, 726's actor changed, four hashes changed.
//
// Everything Canon can check about itself is a check of the record against the
// record, and a wholesale recomputation makes the record agree with itself
// again. A copy taken earlier and held elsewhere is outside that loop. It is
// the only artefact in this product that is, short of an operator publishing
// the head hash off-box — and unlike that, it is already in the hands of the
// person who needs it, because it is the file we handed them.
//
// So this module exists to make the check she performed by hand something a
// reader can run in one command, and to make the finding it produces precise
// enough to act on: not "these files differ" but "event 724 is gone; event
// 726's actor changed from Marcus Bell to Priya Raman; four chain hashes over
// unchanged content were recomputed".
//
// ---------------------------------------------------------------------------
// WHAT IT READS, AND WHAT IT REFUSES TO TRUST
//
// Two JSON bundles and nothing else. It opens no database, makes no request,
// and asks no Canon anything — a comparison that phoned Canon to ask which of
// the two files was right would be a comparison with the same weakness as
// everything else. That also means it can be run years later, on a laptop,
// against files from a deployment that no longer exists.
//
// It trusts NEITHER file. Both are read as claims: each is checked against its
// own content digest and each event against its own chain link, and then the
// two are compared. A difference is reported as a difference, with both values,
// and it is left to a reader to decide which copy is the honest one — because
// this code cannot know, and pretending to would be the same overclaim the rest
// of this product refuses.
//
// ---------------------------------------------------------------------------
// THE THREE SEVERITIES
//
//   tamper    Something that was true in the earlier copy is not true in the
//             later one, and the record cannot legitimately do that. A deleted
//             event, an altered actor, a rewritten hash over identical content,
//             an event inserted into the past, a version whose text changed.
//             History is append-only; nothing here has an innocent reading.
//
//   question  Something a reader must resolve before drawing a conclusion, and
//             which has honest explanations. A different generator (so the two
//             bundles are filtered differently), a different `at`, a bundle
//             whose own digest does not recompute, a deployment whose identity
//             configuration changed between the two.
//
//   expected  Ordinary growth. New events, new versions, a chain head that
//             advanced. Reported rather than hidden, because "nothing was added
//             either" is sometimes the surprising half.
//
// `ok` is false when there is any `tamper` finding, and only then. A `question`
// does not make a comparison fail, and this module does not decide for a reader
// what a question means.

export type Severity = 'tamper' | 'question' | 'expected';

export interface ComparisonFinding {
  severity: Severity;
  /** A stable machine-readable name for the kind of difference. */
  kind: string;
  /** Written for the person reading the output, not for a log. */
  message: string;
  eventId?: number;
  earlier?: unknown;
  later?: unknown;
}

export interface BundleSummary {
  format: string;
  subject: { kind: string; id: string; title: string };
  generatedAt: string;
  generatedBy: string;
  at: string | null;
  head: { eventId: number; hash: string } | null;
  events: number;
  versions: number;
  registerEntries: number | null;
  identityMode: string | null;
  contentDigest: string;
  digestRecomputes: boolean;
}

export interface AttestationComparison {
  ok: boolean;
  earlier: BundleSummary;
  later: BundleSummary;
  findings: ComparisonFinding[];
  counts: Record<Severity, number>;
  /** One sentence a reader can quote. */
  verdict: string;
  /** What this comparison does not establish. */
  limits: string[];
}

// ---------------------------------------------------------------------------
// Reading a file that claims to be a bundle
//
// Everything below treats its input as untrusted JSON of unknown shape: a
// bundle that has been edited, truncated, or is not a bundle at all must
// produce a sentence rather than a TypeError with a stack trace. `noUncheckedIndexedAccess`
// helps here and is not sufficient — the values are `unknown`, not merely
// possibly-absent.

type Json = Record<string, unknown>;

function obj(value: unknown): Json | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

interface ReadEvent {
  id: number;
  at: string;
  actorId: string;
  actorName: string;
  actorKind: string;
  action: string;
  collectionId: string | null;
  pageId: string | null;
  details: unknown;
  detailsJson: string;
  chain: { prevHash: string; hash: string } | null;
}

interface ReadVersion {
  number: number;
  title: string;
  body: string;
  fields: unknown;
  authorId: string;
  authorName: string;
  createdAt: string;
}

interface ReadRegisterEntry {
  pageId: string;
  title: string;
  status: string;
  canonical: boolean;
  version: number | null;
  approverId: string | null;
  approverName: string | null;
  approvedAt: string | null;
}

interface ReadIdentityActor {
  actorId: string;
  name: string;
  basis: string;
  issuer: string | null;
  subject: string | null;
}

interface ReadBundle {
  raw: Json;
  manifest: Json;
  format: string;
  subjectKind: string;
  subjectId: string;
  subjectTitle: string;
  generatedAt: string;
  generatedById: string;
  generatedByName: string;
  at: string | null;
  head: { eventId: number; hash: string } | null;
  chainedFromEventId: number | null;
  contentDigest: string;
  recomputedDigest: string;
  events: ReadEvent[];
  versions: ReadVersion[];
  register: ReadRegisterEntry[] | null;
  identityMode: string | null;
  identityIssuer: string | null;
  identityActors: ReadIdentityActor[];
}

/**
 * Read a parsed bundle, or refuse with a sentence naming what is wrong.
 *
 * The refusal is deliberate rather than lenient: a comparison that quietly
 * treated a truncated file as "a bundle with no events" would report a
 * catastrophic deletion, and the auditor would be chasing our bug instead of
 * their forgery.
 */
export function readBundle(parsed: unknown, label: string): ReadBundle {
  const raw = obj(parsed);
  if (!raw) throw new CanonError('invalid', `${label} is not a JSON object, so it is not an attestation bundle`);
  const manifest = obj(raw.manifest);
  if (!manifest) throw new CanonError('invalid', `${label} has no manifest, so it is not an attestation bundle`);
  const format = str(manifest.format) ?? '';
  if (format !== 'veryl-canon-attestation-v1') {
    throw new CanonError(
      'invalid',
      `${label} says its format is '${format || '(none)'}'. This tool reads veryl-canon-attestation-v1 and will ` +
        'not guess at another.',
    );
  }
  const subject = obj(manifest.subject) ?? {};
  const generatedBy = obj(manifest.generatedBy) ?? {};
  const chain = obj(manifest.auditChain) ?? {};
  const headRaw = obj(chain.head);
  const headEventId = headRaw ? num(headRaw.eventId) : null;
  const headHash = headRaw ? str(headRaw.hash) : null;
  const identity = obj(manifest.identity);
  const doors = identity ? obj(identity.doors) : null;

  // The digest recipe from HOW_TO_VERIFY step 1, performed rather than
  // described: the content is the bundle with `manifest` removed, and
  // JSON.parse preserves key order, so the remaining keys serialise in the
  // order the generator wrote them.
  const { manifest: _dropped, ...content } = raw;
  const recomputedDigest = contentDigest(content);

  const events: ReadEvent[] = arr(raw.auditEvents).flatMap((entry) => {
    const e = obj(entry);
    const id = e ? num(e.id) : null;
    if (!e || id === null) return [];
    const link = obj(e.chain);
    return [
      {
        id,
        at: str(e.at) ?? '',
        actorId: str(e.actorId) ?? '',
        actorName: str(e.actorName) ?? '',
        actorKind: str(e.actorKind) ?? '',
        action: str(e.action) ?? '',
        collectionId: str(e.collectionId),
        pageId: str(e.pageId),
        details: e.details ?? {},
        detailsJson: JSON.stringify(e.details ?? {}),
        chain: link ? { prevHash: str(link.prevHash) ?? '', hash: str(link.hash) ?? '' } : null,
      },
    ];
  });

  const versions: ReadVersion[] = arr(raw.versions).flatMap((entry) => {
    const v = obj(entry);
    const number = v ? num(v.number) : null;
    if (!v || number === null) return [];
    return [
      {
        number,
        title: str(v.title) ?? '',
        body: str(v.body) ?? '',
        fields: v.fields ?? null,
        authorId: str(v.authorId) ?? '',
        authorName: str(v.authorName) ?? '',
        createdAt: str(v.createdAt) ?? '',
      },
    ];
  });

  const readEntries = (value: unknown, canonical: boolean): ReadRegisterEntry[] =>
    arr(value).flatMap((entry) => {
      const r = obj(entry);
      const pageId = r ? str(r.pageId) : null;
      if (!r || !pageId) return [];
      return [
        {
          pageId,
          title: str(r.title) ?? '',
          status: str(r.status) ?? '',
          canonical: typeof r.canonical === 'boolean' ? r.canonical : canonical,
          version: num(r.version),
          approverId: str(r.approverId),
          approverName: str(r.approverName),
          approvedAt: str(r.approvedAt),
        },
      ];
    });
  const isRegister = str(subject.kind) === 'collection' || raw.register !== undefined;
  const register = isRegister
    ? [...readEntries(raw.register, true), ...readEntries(raw.notCanonical, false)]
    : null;

  const identityActors: ReadIdentityActor[] = identity
    ? arr(identity.actors).flatMap((entry) => {
        const a = obj(entry);
        const actorId = a ? str(a.actorId) : null;
        if (!a || !actorId) return [];
        return [
          {
            actorId,
            name: str(a.name) ?? '',
            basis: str(a.basis) ?? 'not stated',
            issuer: str(a.issuer),
            subject: str(a.subject),
          },
        ];
      })
    : [];

  return {
    raw,
    manifest,
    format,
    subjectKind: str(subject.kind) ?? '(unknown)',
    subjectId: str(subject.id) ?? '',
    subjectTitle: str(subject.title) ?? '',
    generatedAt: str(manifest.generatedAt) ?? '',
    generatedById: str(generatedBy.id) ?? '',
    generatedByName: str(generatedBy.name) ?? '(unnamed)',
    at: str(manifest.at),
    head: headEventId !== null && headHash !== null ? { eventId: headEventId, hash: headHash } : null,
    chainedFromEventId: num(chain.chainedFromEventId),
    contentDigest: str(manifest.contentDigest) ?? '',
    recomputedDigest,
    events,
    versions,
    register,
    identityMode: doors ? str(doors.mode) : null,
    identityIssuer: doors ? str(doors.issuer) : null,
    identityActors,
  };
}

function summarise(bundle: ReadBundle): BundleSummary {
  return {
    format: bundle.format,
    subject: { kind: bundle.subjectKind, id: bundle.subjectId, title: bundle.subjectTitle },
    generatedAt: bundle.generatedAt,
    generatedBy: `${bundle.generatedByName} (${bundle.generatedById})`,
    at: bundle.at,
    head: bundle.head,
    events: bundle.events.length,
    versions: bundle.versions.length,
    registerEntries: bundle.register ? bundle.register.length : null,
    identityMode: bundle.identityMode,
    contentDigest: bundle.contentDigest,
    digestRecomputes: bundle.contentDigest === bundle.recomputedDigest,
  };
}

/**
 * Recompute one event's chain link from the bundle's own copy of the event.
 *
 * `detailsJson` is reconstructed by re-serialising the parsed details, which is
 * what HOW_TO_VERIFY step 2 tells a reader to do and is exact for everything
 * Canon writes: the stored string was produced by `JSON.stringify` over the
 * same object, and JSON round-trips preserve key order and the serialisation of
 * every value Canon puts in an event's details.
 */
function linkRecomputes(event: ReadEvent): boolean {
  if (!event.chain) return true; // unchained events predate the chain; nothing to check
  return (
    chainHash(event.chain.prevHash, {
      id: event.id,
      at: event.at,
      actorId: event.actorId,
      actorKind: event.actorKind,
      action: event.action,
      collectionId: event.collectionId,
      pageId: event.pageId,
      detailsJson: event.detailsJson,
    }) === event.chain.hash
  );
}

const EVENT_FIELDS: (keyof ReadEvent)[] = [
  'at',
  'actorId',
  'actorName',
  'actorKind',
  'action',
  'collectionId',
  'pageId',
  'detailsJson',
];

const VERSION_FIELDS: (keyof ReadVersion)[] = ['title', 'body', 'authorId', 'authorName', 'createdAt'];

export const COMPARISON_LIMITS: string[] = [
  'This compares two files and nothing else. It does not ask Canon anything, so it cannot tell you which of the ' +
    'two copies is the honest one — only that they disagree, and about what. A reader who holds one of them from ' +
    'their own custody knows which that is; this tool does not.',
  'Both bundles are filtered to what their generator could see. Two bundles generated by different people, or ' +
    'about different instants, can differ honestly, and differences of that kind are reported as questions rather ' +
    'than as findings.',
  'It can only see the events, versions and register rows the two bundles contain. A change to something neither ' +
    'file covered is invisible here, which is why keeping bundles for the material that matters is the whole of ' +
    'the mitigation.',
  'A clean comparison is evidence about the period between the two generation times and about nothing outside it. ' +
    'It says nothing about events that were never written, and nothing about whether the identity behind an ' +
    'attribution was verified — for that, read the identity section of either bundle.',
];

/**
 * Compare two retained bundles. Order is worked out from `generatedAt` rather
 * than trusted from the argument order, because "which of these did I take
 * first" is exactly the thing somebody digging through an evidence folder two
 * years later is least sure of.
 */
export function compareAttestations(first: unknown, second: unknown, labels?: [string, string]): AttestationComparison {
  const [labelA, labelB] = labels ?? ['the first bundle', 'the second bundle'];
  const a = readBundle(first, labelA);
  const b = readBundle(second, labelB);

  if (a.subjectId !== b.subjectId) {
    throw new CanonError(
      'invalid',
      `These two bundles are about different subjects — ${a.subjectKind} ${a.subjectId} and ${b.subjectKind} ` +
        `${b.subjectId}. There is nothing to compare.`,
    );
  }

  const swapped = b.generatedAt !== '' && a.generatedAt !== '' && b.generatedAt < a.generatedAt;
  const earlier = swapped ? b : a;
  const later = swapped ? a : b;
  const findings: ComparisonFinding[] = [];
  const add = (severity: Severity, kind: string, message: string, extra: Partial<ComparisonFinding> = {}): void => {
    findings.push({ severity, kind, message, ...extra });
  };

  if (swapped) {
    add(
      'expected',
      'order',
      `The bundles were given in the other order and have been swapped: ${later.generatedAt} was generated after ` +
        `${earlier.generatedAt}, so it is treated as the later copy.`,
    );
  }

  // ---- each bundle against itself --------------------------------------

  for (const [which, bundle] of [
    ['earlier', earlier],
    ['later', later],
  ] as const) {
    if (bundle.contentDigest !== bundle.recomputedDigest) {
      add(
        'question',
        'digest_mismatch',
        `The ${which} bundle's content does not reproduce its own manifest digest. Either the file was edited ` +
          'after it was generated, or it was written by a different version of Canon whose serialisation differs. ' +
          'Nothing below is safe to rely on for this copy until that is resolved.',
        { earlier: bundle.contentDigest, later: bundle.recomputedDigest },
      );
    }
    for (const event of bundle.events) {
      if (!linkRecomputes(event)) {
        add(
          'tamper',
          'link_mismatch_within_bundle',
          `In the ${which} bundle, event ${event.id} does not hash to the chain link recorded beside it. That ` +
            'event\'s content is not what was hashed when it was written.',
          { eventId: event.id },
        );
      }
    }
  }

  // ---- the two against each other, before the record itself ------------

  if (earlier.generatedById !== later.generatedById) {
    add(
      'question',
      'different_generator',
      `These bundles were generated by different actors — ${earlier.generatedByName} and ${later.generatedByName}. ` +
        'A bundle is filtered to what its generator could see, so a difference below may be a difference in ' +
        'permission rather than in the record.',
    );
  }
  if (earlier.at !== later.at) {
    add(
      'question',
      'different_instant',
      `These bundles answer about different instants (${earlier.at ?? 'no as-of'} and ${later.at ?? 'no as-of'}). ` +
        'Point-in-time sections describe different moments and are expected to differ.',
    );
  }
  if (
    earlier.chainedFromEventId !== null &&
    later.chainedFromEventId !== null &&
    earlier.chainedFromEventId !== later.chainedFromEventId
  ) {
    add(
      'question',
      'chain_start_moved',
      `The chain's starting event id changed between the two copies (${earlier.chainedFromEventId} → ` +
        `${later.chainedFromEventId}). Either these are two different records, or the chain was re-established on ` +
        'this one — which is worth an explanation, because it is what somebody would do to give a rewritten log a ' +
        'clean starting point.',
    );
  }
  if (earlier.identityMode !== later.identityMode || earlier.identityIssuer !== later.identityIssuer) {
    add(
      'question',
      'identity_configuration_changed',
      `How this Canon establishes identity changed between the two copies: ${earlier.identityMode ?? 'not stated'}` +
        `${earlier.identityIssuer ? ` (${earlier.identityIssuer})` : ''} → ${later.identityMode ?? 'not stated'}` +
        `${later.identityIssuer ? ` (${later.identityIssuer})` : ''}. Attributions made under each configuration ` +
        'carry different weight; read the identity section of both.',
    );
  }

  // An actor who WAS federated and now is not has had their provider subject
  // removed from the record — which is how somebody would make an impostor and
  // a real person look alike after the fact.
  const earlierIdentity = new Map(earlier.identityActors.map((i) => [i.actorId, i]));
  for (const now of later.identityActors) {
    const then = earlierIdentity.get(now.actorId);
    if (!then) continue;
    if (then.basis === 'federated' && now.basis !== 'federated') {
      add(
        'tamper',
        'identity_downgraded',
        `${then.name} was federated in the earlier copy (subject ${then.subject ?? 'unrecorded'}, issuer ` +
          `${then.issuer ?? 'unrecorded'}) and is now '${now.basis}'. The identity-provider subject that tied this ` +
          'actor to a real person has been removed from the record.',
      );
    } else if (then.basis === 'federated' && now.basis === 'federated' && then.subject !== now.subject) {
      add(
        'tamper',
        'identity_subject_changed',
        `${then.name}'s identity-provider subject changed from ${then.subject ?? 'unrecorded'} to ` +
          `${now.subject ?? 'unrecorded'}. An actor's history now belongs to a different person at the provider.`,
      );
    }
  }

  // ---- the head --------------------------------------------------------

  if (earlier.head && later.head) {
    if (later.head.eventId < earlier.head.eventId) {
      add(
        'tamper',
        'head_went_backwards',
        `The chain head moved BACKWARDS: event ${earlier.head.eventId} in the earlier copy, ` +
          `${later.head.eventId} now. An append-only log cannot get shorter.`,
      );
    } else if (later.head.eventId === earlier.head.eventId && later.head.hash !== earlier.head.hash) {
      add(
        'tamper',
        'head_hash_changed',
        `The chain head is still event ${earlier.head.eventId} but its hash changed, from ${earlier.head.hash} to ` +
          `${later.head.hash}. The same log position now hashes to something else: the chain has been recomputed ` +
          'over altered history. This is the finding a retained bundle exists to produce.',
      );
    } else if (later.head.eventId > earlier.head.eventId) {
      add(
        'expected',
        'head_advanced',
        `The chain head advanced from event ${earlier.head.eventId} to ${later.head.eventId}: ` +
          `${later.head.eventId - earlier.head.eventId} event(s) were appended to the record in between.`,
      );
    }
  }

  // ---- the events ------------------------------------------------------

  const earlierEvents = new Map(earlier.events.map((e) => [e.id, e]));
  const laterEvents = new Map(later.events.map((e) => [e.id, e]));
  const headThen = earlier.head?.eventId ?? Number.MAX_SAFE_INTEGER;

  for (const [id, then] of earlierEvents) {
    const now = laterEvents.get(id);
    if (!now) {
      add(
        'tamper',
        'event_deleted',
        `Audit event ${id} is in the retained copy and is GONE from the later one: '${then.action}' by ` +
          `${then.actorName} at ${then.at}. The audit log is append-only; an event cannot leave it.`,
        { eventId: id, earlier: { action: then.action, actor: then.actorName, at: then.at } },
      );
      continue;
    }
    for (const field of EVENT_FIELDS) {
      if (then[field] === now[field]) continue;
      add(
        'tamper',
        'event_changed',
        `Audit event ${id} ('${then.action}') has a different ${String(field)}: ${JSON.stringify(then[field])} in ` +
          `the retained copy, ${JSON.stringify(now[field])} now.`,
        { eventId: id, earlier: then[field], later: now[field] },
      );
    }
    const sameContent = EVENT_FIELDS.every((field) => then[field] === now[field]);
    if (sameContent && then.chain && now.chain && then.chain.hash !== now.chain.hash) {
      add(
        'tamper',
        'event_rehashed',
        `Audit event ${id} is unchanged but its chain hash was recomputed: ${then.chain.hash} → ${now.chain.hash}. ` +
          'The link over an untouched event changes only when the history in front of it changed — this is the ' +
          'signature of a wholesale recomputation, which is exactly what an internal consistency check cannot see.',
        { eventId: id, earlier: then.chain.hash, later: now.chain.hash },
      );
    }
  }

  let appended = 0;
  for (const [id, now] of laterEvents) {
    if (earlierEvents.has(id)) continue;
    if (id <= headThen) {
      add(
        'tamper',
        'event_inserted_into_the_past',
        `Audit event ${id} ('${now.action}' by ${now.actorName} at ${now.at}) is in the later copy and was not in ` +
          `the retained one, but it sits at or below the chain head that copy recorded (event ${headThen}). It was ` +
          'inserted into history rather than appended to it.',
        { eventId: id },
      );
    } else {
      appended += 1;
    }
  }
  if (appended > 0) {
    add(
      'expected',
      'events_appended',
      `${appended} audit event(s) were appended after the retained copy was taken. That is what an append-only log ` +
        'is supposed to do.',
    );
  }

  // ---- the versions ----------------------------------------------------

  const earlierVersions = new Map(earlier.versions.map((v) => [v.number, v]));
  const laterVersions = new Map(later.versions.map((v) => [v.number, v]));
  for (const [number, then] of earlierVersions) {
    const now = laterVersions.get(number);
    if (!now) {
      add(
        'tamper',
        'version_deleted',
        `Version ${number} ('${then.title}', published ${then.createdAt} by ${then.authorName}) is in the retained ` +
          'copy and is gone from the later one. Versions are immutable and are never removed.',
      );
      continue;
    }
    for (const field of VERSION_FIELDS) {
      if (then[field] === now[field]) continue;
      const detail =
        field === 'body'
          ? `its text changed (${String(then.body).length} characters then, ${String(now.body).length} now)`
          : `${String(field)}: ${JSON.stringify(then[field])} → ${JSON.stringify(now[field])}`;
      add('tamper', 'version_changed', `Version ${number} was rewritten — ${detail}.`, {
        earlier: then[field],
        later: now[field],
      });
    }
    if (JSON.stringify(then.fields) !== JSON.stringify(now.fields)) {
      add(
        'tamper',
        'version_fields_changed',
        `Version ${number}'s structured fields changed: ${JSON.stringify(then.fields)} → ${JSON.stringify(now.fields)}.`,
        { earlier: then.fields, later: now.fields },
      );
    }
  }
  const newVersions = [...laterVersions.keys()].filter((n) => !earlierVersions.has(n));
  if (newVersions.length > 0) {
    add(
      'expected',
      'versions_published',
      `Version(s) ${newVersions.join(', ')} were published after the retained copy was taken.`,
    );
  }

  // ---- the register ----------------------------------------------------
  //
  // Only where the two registers answer about the SAME instant. A register
  // drawn for a different date is a different question, and comparing the two
  // would manufacture findings out of the record doing exactly what it should.

  if (earlier.register && later.register) {
    if (earlier.at !== later.at) {
      add(
        'question',
        'register_not_compared',
        'The two registers are drawn as at different instants, so their rows are not compared. Generate the later ' +
          `register with ?at=${earlier.at ?? '<the earlier instant>'} to compare like with like.`,
      );
    } else {
      const earlierRows = new Map(earlier.register.map((r) => [r.pageId, r]));
      const laterRows = new Map(later.register.map((r) => [r.pageId, r]));
      for (const [pageId, then] of earlierRows) {
        const now = laterRows.get(pageId);
        if (!now) {
          add(
            'tamper',
            'register_row_missing',
            `Page ${pageId} ('${then.title}') stood in this register as at ${earlier.at} and is absent from the ` +
              'later copy drawn for the same instant. A page in the record does not stop having existed.',
          );
          continue;
        }
        if (then.canonical !== now.canonical) {
          add(
            'tamper',
            'register_standing_changed',
            `Page ${pageId} ('${then.title}') was ${then.canonical ? 'Canonical' : 'not Canonical'} as at ` +
              `${earlier.at} and is now recorded as ${now.canonical ? 'Canonical' : 'not Canonical'} at that same ` +
              'instant. What a page WAS cannot change.',
          );
        }
        if (then.approverId !== now.approverId) {
          add(
            'tamper',
            'register_approver_changed',
            `Page ${pageId} ('${then.title}') was approved by ${then.approverName ?? then.approverId ?? 'nobody'} ` +
              `as at ${earlier.at}; the later copy says ${now.approverName ?? now.approverId ?? 'nobody'}. An ` +
              'approval is an event in history and cannot be reassigned.',
          );
        }
        // The approval that granted the mark, matched to the version that
        // held it. This is the row that goes null when somebody deletes a
        // `page.approve` event — the standing above can survive that, because
        // it is derived from the publish that carried the mark, so the two
        // checks catch different halves of the same forgery.
        if (then.approvedAt !== now.approvedAt) {
          add(
            'tamper',
            'register_approval_changed',
            `Page ${pageId} ('${then.title}') was approved at ${then.approvedAt ?? 'no approval recorded'} as at ` +
              `${earlier.at}; the later copy says ${now.approvedAt ?? 'no approval recorded'}. An approval is an ` +
              'event in history: it cannot move, and it cannot stop having happened.',
          );
        }
        if (then.version !== now.version) {
          add(
            'tamper',
            'register_version_changed',
            `Page ${pageId} ('${then.title}') stood at version ${then.version ?? 'none'} as at ${earlier.at}; the ` +
              `later copy says version ${now.version ?? 'none'}.`,
          );
        }
      }
      const added = [...laterRows.keys()].filter((id) => !earlierRows.has(id));
      if (added.length > 0) {
        add(
          'tamper',
          'register_row_added',
          `${added.length} page(s) appear in the later register for the same instant and were not in the retained ` +
            'copy: ' +
            added.join(', ') +
            '. A register drawn for a past instant cannot gain rows.',
        );
      }
    }
  }

  const counts: Record<Severity, number> = {
    tamper: findings.filter((f) => f.severity === 'tamper').length,
    question: findings.filter((f) => f.severity === 'question').length,
    expected: findings.filter((f) => f.severity === 'expected').length,
  };
  const ok = counts.tamper === 0;
  const verdict = ok
    ? `No difference between these two copies that the record could not have made honestly. Everything the ` +
      `retained copy from ${earlier.generatedAt} asserted is still asserted by the copy from ${later.generatedAt}` +
      (counts.question > 0
        ? `, but ${counts.question} question(s) below need resolving before that is worth quoting.`
        : '.')
    : `${counts.tamper} difference(s) that an append-only record cannot produce. Something the retained copy from ` +
      `${earlier.generatedAt} asserted is no longer true of the record, and the later copy from ` +
      `${later.generatedAt} may verify perfectly against itself while being wrong. Read the findings below.`;

  return { ok, earlier: summarise(earlier), later: summarise(later), findings, counts, verdict, limits: COMPARISON_LIMITS };
}

/**
 * The comparison as a person reads it. Kept here rather than in the script so
 * that the wording is testable, on the same argument the rest of this codebase
 * makes about explanations belonging next to the thing they explain.
 */
export function renderComparison(result: AttestationComparison): string {
  const lines: string[] = [];
  const rule = '-'.repeat(78);
  lines.push('Veryl Canon — comparison of two retained attestations');
  lines.push(rule);
  lines.push(`Subject          ${result.earlier.subject.kind} ${result.earlier.subject.id}`);
  lines.push(`                 ${result.earlier.subject.title}`);
  for (const [label, side] of [
    ['Retained copy', result.earlier],
    ['Later copy', result.later],
  ] as const) {
    lines.push('');
    lines.push(`${label}`);
    lines.push(`  generated      ${side.generatedAt} by ${side.generatedBy}`);
    lines.push(`  as at          ${side.at ?? '(not a point-in-time bundle)'}`);
    lines.push(`  chain head     ${side.head ? `event ${side.head.eventId} · ${side.head.hash}` : '(none)'}`);
    lines.push(
      `  contents       ${side.events} audit event(s), ${side.versions} version(s)` +
        (side.registerEntries === null ? '' : `, ${side.registerEntries} register row(s)`),
    );
    lines.push(`  identity       ${side.identityMode ?? 'not stated in this bundle'}`);
    lines.push(
      `  own digest     ${side.digestRecomputes ? 'recomputes' : 'DOES NOT RECOMPUTE — this file has been altered'}`,
    );
  }
  lines.push('');
  lines.push(rule);
  lines.push(result.ok ? 'VERDICT: no impossible difference found.' : 'VERDICT: THE RECORD HAS CHANGED BEHIND YOU.');
  lines.push(result.verdict);
  lines.push(rule);

  for (const [heading, severity] of [
    ['Differences an append-only record cannot make', 'tamper'],
    ['Questions to resolve first', 'question'],
    ['Ordinary growth', 'expected'],
  ] as const) {
    const group = result.findings.filter((f) => f.severity === severity);
    if (group.length === 0) continue;
    lines.push('');
    lines.push(`${heading} (${group.length})`);
    for (const finding of group) {
      lines.push(`  [${finding.kind}] ${finding.message}`);
    }
  }

  lines.push('');
  lines.push('What this comparison does not establish');
  for (const limit of result.limits) lines.push(`  - ${limit}`);
  return lines.join('\n') + '\n';
}
