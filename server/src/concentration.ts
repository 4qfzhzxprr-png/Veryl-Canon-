import type { DatabaseSync } from 'node:sqlite';
import { DocType, Role, ROLE_RANK, TYPE_RULES } from './model.js';

// Concentration of duty: who granted the Canonical marks in a collection, out
// of how many people could have, and where their authority to do it came from.
//
// ---------------------------------------------------------------------------
// WHY THIS FILE EXISTS
//
// USER-TESTING.md T4.8 recorded that all sixteen Canonical clinical policies in
// the demo corpus had been approved by one person, and the auditor's sentence
// was: "I cannot distinguish a genuine single-approver concentration risk from
// a fixture artefact, and the client should not assume the latter." The corpus
// was rebuilt to spread approvals across two named approvers per collection, so
// the artefact is gone.
//
// The artefact was never the finding. On re-review the same auditor asked for
// "a concentration-of-duty view distinguishing an authorised approval
// concentration from an accidental one — the register now exposes the fact, but
// not its legitimacy". She could already see, per row, who approved what. What
// she could not do was answer the question an auditor actually asks: IS IT
// ACCEPTABLE that these two people granted every Canonical mark here?
//
// That question has no answer inside a database. It depends on the size of the
// team, on what the material is, on what the organisation wrote down about who
// may approve what — none of which Canon holds. What Canon does hold is the
// four facts a person needs before they can answer it themselves, and until now
// each of them was a separate expedition through a different screen:
//
//   1. WHO GRANTED, AND HOW MANY EACH. Read from the `page.approve` events, not
//      from `pages.approver_id`. Those are different questions and they have
//      different answers. The column is the person NAMED to approve. A Plan
//      need not name one — `TYPE_RULES.plan` requires no approver, so `approve`
//      accepts ANY holder of the role — so on a Plan the column is either null
//      while somebody unmistakably did grant the mark, or a name that the
//      person who actually granted it need not match. The register showed the
//      named approver and an approval time, so a Plan's row read "Approver: —,
//      Approved: 3 March", which is the shape of a fact with the actor filed
//      off.
//
//   2. OUT OF HOW MANY. Two people out of two available approvers and two out
//      of nine are different findings, and the second is the one that wants a
//      conversation. The denominator is the collection's own roster: everybody
//      holding a role that satisfies `approve`, which is `approve` and `admin`,
//      derived from ROLE_RANK exactly as `requireRole` derives it. The people
//      who hold it and have granted nothing are named too — a dormant right to
//      approve is a fact an auditor samples, not a rounding error.
//
//   3. WHERE THE AUTHORITY CAME FROM. orgrole.ts keeps hand grants and grants
//      that follow from a directory group mapping in two tables precisely so
//      this question is answerable. "This concentration follows from your group
//      mapping" and "somebody added these two by hand" are different sentences
//      about the same two names, and only the first can be checked against
//      something outside Canon.
//
//   4. WHETHER THE APPROVER ALSO PUT THE WORK FORWARD, and whether the approver
//      also administers the collection — which is to say, whether they can
//      change who approves here, including by granting it to themselves.
//
// ---------------------------------------------------------------------------
// THE NUMBER THIS FILE REFUSES TO COMPUTE
//
// There is no score. No index, no ratio dressed as one, no "concentration:
// 0.82", no red/amber/green. A single number over these facts would be
// authoritative-looking and meaningless: it would have to weigh "two of nine"
// against "one of one" against "granted by hand" against "granted by a group",
// and every one of those weights would be a policy judgement invented in this
// file on behalf of an organisation that never made it. An auditor handed such
// a number has to reverse-engineer it before she can trust it, which is more
// work than reading the counts it was made from.
//
// So this reports counts, names, and origins, and says in words what it counted.
// The same decision `collectionHealth` makes about `backdatedWithoutBasis`: a
// count that can be opened, beside a sentence saying what it is a count OF.
//
// ---------------------------------------------------------------------------
// PERMISSION
//
// Every query below joins `collection_members` for the ASKING actor, the way
// queries.ts requires and for the reason its header gives — the filtering is in
// the SELECT, so a non-member gets an empty answer because nothing was ever
// selected. That join is repeated in each of the three reads rather than
// hoisted into one caller-side check, because a caller-side check is a thing a
// future caller can forget.
//
// Nothing here discloses more than the collection already does to a `view`
// holder: `listMembers` returns the whole roster with roles to anybody who can
// read the collection, and the approvals are `page.approve` events on pages in
// it, which `GET /audit` already narrows to members. The one exception is the
// NAME of a directory group, which `explainAccess` treats as an operator's
// question — so a group name is printed only to a reader who could already ask
// for it by name, and its absence is declared in `groupsWithheld` rather than
// left as a silent blank. A withheld fact that does not say it was withheld is
// the failure this whole product is against.

/**
 * How the authority to approve reached one person in one collection.
 *
 * The three that matter are distinguishable because orgrole.ts stores the two
 * sides separately and derives `collection_members` from them. `not_held_now`
 * is the fourth and it is a real state: somebody who granted a mark last year
 * and has since left the collection.
 *
 * `unrecorded` is the fifth and should never occur. A membership row is written
 * by `recomputeMembership` from one of the two grant tables, and orgrole.ts
 * backfills a hand grant for every row a record already held, so a member with
 * neither is a row somebody wrote to `collection_members` directly. Saying
 * "granted by hand" over it would be inventing an origin, so it says it does
 * not know.
 */
export type GrantOrigin = 'hand' | 'group' | 'hand_and_group' | 'not_held_now' | 'unrecorded';

/** One person, on either side of the count. */
export interface ApproverStanding {
  actorId: string;
  name: string;
  /** Marks in THIS population that this person granted. Zero for a dormant holder. */
  marks: number;
  /** The first and last of them, so a burst is distinguishable from a habit. */
  firstAt: string | null;
  lastAt: string | null;
  /** The effective role held in this collection TODAY, or null if none is held. */
  role: Role | null;
  /** That role satisfies `approve`: this person could grant a mark here now. */
  mayApproveNow: boolean;
  /** They hold `admin` here, so they may change who approves — themselves included. */
  collectionAdmin: boolean;
  origin: GrantOrigin;
  /**
   * The directory groups behind a mapped grant, strongest role first. Empty
   * where the reader may not be told the names; `groupsWithheld` on the report
   * says which of the two an empty list means.
   */
  groups: { group: string; role: Role }[];
  /** Plain English about this person's standing. Never switched on by code. */
  statement: string;
}

/**
 * One mark whose approver was also the person who submitted the draft it
 * published. Named per row rather than counted, the way the register names its
 * excluded pages: a count of one is a question about a particular page.
 */
export interface SelfApprovedMark {
  pageId: string;
  title: string;
  type: DocType;
  approverId: string;
  approverName: string;
  approvedAt: string;
  /**
   * Whether Canon's own submit-time refusal covers this type. It fires only
   * where the type names an approver (`TYPE_RULES[type].requiresApprover`), so
   * on a Plan — which names nobody, and which any holder of `approve` may
   * accept — the same person CAN submit and then approve. A row here with
   * `refusedAtSubmission: false` is that case, and it is the whole reason this
   * check is run over the record rather than assumed from the code.
   */
  refusedAtSubmission: boolean;
}

/** The whole answer for one collection, over one population of marks. */
export interface ConcentrationOfDuty {
  collectionId: string;
  /** The instant or day this was asked about, as the caller expressed it. */
  at: string;
  /** What was counted, in words. A count nobody can describe is a rumour. */
  population: string;
  /** Marks in the population. */
  marks: number;
  /**
   * Marks in the population for which no `page.approve` event names the version
   * standing. Reported rather than smoothed over — the same treatment
   * `reconstruct` gives the same anomaly — because it means either a page that
   * reached Canonical by a path that did not audit itself, or a log with a hole.
   */
  marksWithoutApprovalEvent: number;
  /** Everybody who granted at least one, most granted first, then by name. */
  granters: ApproverStanding[];
  /** Everybody who may approve here and granted none of these marks. */
  dormant: ApproverStanding[];
  /** How many people hold a role satisfying `approve` here today: the denominator. */
  eligible: number;
  /** Granters who no longer hold that role. Named as the exception it is. */
  grantersWithoutTheRoleNow: number;
  /** Marks whose approver also submitted the draft that was published. */
  selfApproved: SelfApprovedMark[];
  /** Marks where Canon found the submission and compared the two people. */
  separationChecked: number;
  /**
   * Marks where Canon could not find the submission that preceded the approval,
   * so it made no comparison. Not "passed" — unknown, and counted as unknown.
   */
  separationUnknown: number;
  /** A directory group's name was withheld from this reader on at least one row. */
  groupsWithheld: boolean;
  /** The sentence a reader reads first. Facts, no verdict. */
  headline: string;
  /** The two or three sentences after it, each about something countable. */
  notes: string[];
  limits: string[];
  /** The population was capped; these counts are a floor, not a total. */
  truncated: boolean;
}

/** One page in the population. The caller decides which pages are in it. */
export interface MarkedPage {
  pageId: string;
  title: string;
  type: DocType;
  /** The version standing at the instant asked about — what the approval must name. */
  version: number | null;
}

/**
 * The roles that satisfy `approve`, derived from ROLE_RANK as `requireRole`
 * derives it rather than written out, so a sixth role changes this denominator
 * by changing that table. Identical in spirit to `APPROVING_ROLES` in
 * queries.ts, which asks the same question of a different set of rows.
 */
const APPROVING_ROLES: readonly Role[] = (Object.keys(ROLE_RANK) as Role[]).filter(
  (r) => ROLE_RANK[r] >= ROLE_RANK.approve,
);

function placeholders(n: number): string {
  return new Array(n).fill('?').join(', ');
}

interface ApprovalFact {
  pageId: string;
  version: number | null;
  approverId: string;
  at: string;
  eventId: number;
}

/**
 * Every `page.approve` in this collection, oldest first, as the asking actor
 * may see them. The membership join is the permission filter and is inside this
 * SELECT, so a non-member reads no approvals rather than reading them and
 * having them removed afterwards.
 */
function approvalsIn(db: DatabaseSync, actorId: string, collectionId: string): ApprovalFact[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.page_id, a.actor_id, a.at, a.details_json
         FROM audit_events a
         JOIN pages p ON p.id = a.page_id
         JOIN collection_members m ON m.collection_id = p.collection_id AND m.actor_id = ?
        WHERE p.collection_id = ? AND a.action = 'page.approve'
        ORDER BY a.id`,
    )
    .all(actorId, collectionId) as Record<string, unknown>[];
  return rows.map((r) => {
    const details = JSON.parse(r.details_json as string) as Record<string, unknown>;
    return {
      pageId: r.page_id as string,
      version: typeof details.version === 'number' ? details.version : null,
      approverId: r.actor_id as string,
      at: r.at as string,
      eventId: Number(r.id),
    };
  });
}

/**
 * Every `page.submit` in this collection, oldest first, under the same join.
 * The submitter of the draft an approval published is the last submission
 * BEFORE that approval's event id — the same reading `store.lastSubmission`
 * takes for one page, made once for the whole collection because this report
 * asks it of every marked page at once.
 *
 * Event id rather than timestamp: two events written in the same millisecond
 * order correctly by id and not by `at`, and this is exactly the pair of acts
 * (submit, then approve) that can land in one.
 */
function submissionsIn(db: DatabaseSync, actorId: string, collectionId: string): { pageId: string; eventId: number; actorId: string }[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.page_id, a.actor_id
         FROM audit_events a
         JOIN pages p ON p.id = a.page_id
         JOIN collection_members m ON m.collection_id = p.collection_id AND m.actor_id = ?
        WHERE p.collection_id = ? AND a.action = 'page.submit'
        ORDER BY a.id`,
    )
    .all(actorId, collectionId) as Record<string, unknown>[];
  return rows.map((r) => ({ pageId: r.page_id as string, eventId: Number(r.id), actorId: r.actor_id as string }));
}

interface RosterEntry {
  actorId: string;
  role: Role;
  hand: Role | null;
  groups: { group: string; role: Role }[];
}

/**
 * Who may approve in this collection today, and where each one's role came
 * from. The `EXISTS` is the permission filter: it makes the roster empty for a
 * non-member, so this function is safe on its own rather than safe because
 * somebody remembered to check first.
 */
function approverRoster(db: DatabaseSync, actorId: string, collectionId: string): RosterEntry[] {
  const rows = db
    .prepare(
      `SELECT m.actor_id, m.role
         FROM collection_members m
        WHERE m.collection_id = ?
          AND m.role IN (${placeholders(APPROVING_ROLES.length)})
          AND EXISTS (SELECT 1 FROM collection_members me
                       WHERE me.collection_id = m.collection_id AND me.actor_id = ?)
        ORDER BY m.actor_id`,
    )
    .all(collectionId, ...APPROVING_ROLES, actorId) as { actor_id: string; role: Role }[];
  return rows.map((r) => ({
    actorId: r.actor_id,
    role: r.role,
    ...grantOriginOf(db, collectionId, r.actor_id),
  }));
}

/**
 * The two sides of one person's collection role, read from the tables orgrole.ts
 * keeps them in. `collection_members` holds the EFFECTIVE role and cannot answer
 * this: it is the strongest of the two sides and says nothing about which side
 * it came from, which is the whole reason the other two tables exist.
 */
function grantOriginOf(
  db: DatabaseSync,
  collectionId: string,
  memberId: string,
): { hand: Role | null; groups: { group: string; role: Role }[] } {
  const hand = db
    .prepare('SELECT role FROM collection_hand_grants WHERE collection_id = ? AND actor_id = ?')
    .get(collectionId, memberId) as { role: Role } | undefined;
  const groups = (
    db
      .prepare(
        'SELECT group_name, role FROM collection_group_grants WHERE collection_id = ? AND actor_id = ? ORDER BY group_name',
      )
      .all(collectionId, memberId) as { group_name: string; role: Role }[]
  )
    .map((g) => ({ group: g.group_name, role: g.role }))
    .sort((a, b) => ROLE_RANK[b.role] - ROLE_RANK[a.role] || a.group.localeCompare(b.group));
  return { hand: hand?.role ?? null, groups };
}

function originOf(entry: RosterEntry | null): GrantOrigin {
  if (!entry) return 'not_held_now';
  if (entry.hand && entry.groups.length) return 'hand_and_group';
  if (entry.groups.length) return 'group';
  return entry.hand ? 'hand' : 'unrecorded';
}

function originSentence(origin: GrantOrigin, groups: { group: string; role: Role }[], withheld: boolean): string {
  const named = groups.length && !withheld ? ` (${groups.map((g) => `${g.group} → ${g.role}`).join(', ')})` : '';
  switch (origin) {
    case 'hand':
      return 'Their role here was granted by hand, in Canon, by an administrator — the grant is a ' +
        '`collection.member_set` event with that administrator’s name on it.';
    case 'group':
      return `Their role here follows from your directory group mapping${named}${withheld ? ' (group names withheld from this reader)' : ''}: ` +
        'nobody granted it in Canon, and it is re-evaluated against the provider on every confirmation of their ' +
        'session. Check it against the group, not against Canon.';
    case 'hand_and_group':
      return `They hold a role here from BOTH a hand grant and your directory group mapping${named}${withheld ? ' (group names withheld from this reader)' : ''}. ` +
        'Removing the group would not remove their access, and removing the hand grant would not either; the ' +
        'effective role is the stronger of the two.';
    case 'not_held_now':
      return 'They hold NO role in this collection today. They granted the mark(s) counted here and have since ' +
        'lost or given up the role — or the role was withdrawn. Canon does not version membership, so it cannot ' +
        'show what they held at the time; it can only show that they do not hold it now.';
    case 'unrecorded':
      return 'They hold a role here that neither a hand grant nor a group mapping accounts for. That should not ' +
        'happen: every membership row Canon writes is derived from one of those two tables. Nothing is claimed ' +
        'about where this role came from, and it is worth asking who wrote it.';
  }
}

/**
 * The population record health asks about: the pages in this collection that
 * hold the Canonical mark right now.
 *
 * `needs_update` counts alongside `canonical`, exactly as it does for the
 * effective-date counts in `collectionHealth` and for the same reason: a page
 * the freshness sweep flipped HELD the mark, somebody granted it, and it can
 * still be cited and still be handed to a regulator. A draft that was never
 * approved is not in this population and neither is an archived page, which
 * has left the record's active surface.
 *
 * The membership join is the permission filter, in the SELECT, per the rule at
 * the head of queries.ts.
 */
export function marksStandingIn(
  db: DatabaseSync,
  actorId: string,
  collectionId: string,
  limit: number,
): MarkedPage[] {
  const rows = db
    .prepare(
      `SELECT p.id, p.title, p.type, p.current_version
         FROM pages p
         JOIN collection_members m ON m.collection_id = p.collection_id AND m.actor_id = ?
        WHERE p.collection_id = ? AND p.status IN ('canonical', 'needs_update')
        ORDER BY p.position, p.id
        LIMIT ?`,
    )
    .all(actorId, collectionId, limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    pageId: r.id as string,
    title: r.title as string,
    type: r.type as DocType,
    version: (r.current_version as number) ?? null,
  }));
}

/**
 * Build the report.
 *
 * The caller supplies the population — which pages count as "marked", and the
 * version standing on each — because the two surfaces that want this report
 * define it differently and both are right. Record health means "the pages that
 * hold the mark today"; the register means "the pages that held it at the
 * instant this attestation is drawn for". Deriving one from the other would
 * make one of the two answer a question nobody asked, so the population arrives
 * as a parameter and is described in words on the way out.
 */
export function concentrationOfDuty(input: {
  db: DatabaseSync;
  /** Whose permissions this read runs under. Every SELECT joins on it. */
  actorId: string;
  collectionId: string;
  at: string;
  pages: MarkedPage[];
  /** What `pages` is, said the way a reader would say it. */
  population: string;
  /**
   * Whether this reader may be told the NAME of a directory group. Operators
   * may — `explainAccess` already tells them, for any actor — and nobody else
   * is, because a group name is a fact about the organisation's directory
   * rather than about this collection.
   */
  namesGroups: boolean;
  truncated?: boolean;
}): ConcentrationOfDuty {
  const { db, actorId, collectionId } = input;

  const roster = approverRoster(db, actorId, collectionId);
  const rosterById = new Map(roster.map((r) => [r.actorId, r]));

  // The approval that granted the standing of each marked page: the one naming
  // the version standing on it. Matched on the version rather than taken as
  // "the last approval on this page", for the reason `reconstruct` gives — a
  // page approved at v3 and republished at v4 has lost the mark v3 carried, and
  // reporting v3's approver as the granter of what stands now would attribute a
  // decision to somebody who never made it.
  const approvals = approvalsIn(db, actorId, collectionId);
  const byPageAndVersion = new Map<string, ApprovalFact>();
  for (const a of approvals) byPageAndVersion.set(`${a.pageId}@${a.version}`, a);

  // Indexed by page, oldest first, so "the submission this approval acted on"
  // is a walk backwards through one page's own submissions rather than a scan
  // of the collection's per marked page.
  const submissionsByPage = new Map<string, { eventId: number; actorId: string }[]>();
  for (const s of submissionsIn(db, actorId, collectionId)) {
    const list = submissionsByPage.get(s.pageId);
    if (list) list.push({ eventId: s.eventId, actorId: s.actorId });
    else submissionsByPage.set(s.pageId, [{ eventId: s.eventId, actorId: s.actorId }]);
  }

  const marksBy = new Map<string, { marks: number; firstAt: string; lastAt: string }>();
  const selfApproved: SelfApprovedMark[] = [];
  let marksWithoutApprovalEvent = 0;
  let separationChecked = 0;
  let separationUnknown = 0;

  for (const page of input.pages) {
    const approval = byPageAndVersion.get(`${page.pageId}@${page.version}`);
    if (!approval) {
      marksWithoutApprovalEvent += 1;
      continue;
    }
    const tally = marksBy.get(approval.approverId);
    if (!tally) {
      marksBy.set(approval.approverId, { marks: 1, firstAt: approval.at, lastAt: approval.at });
    } else {
      tally.marks += 1;
      if (approval.at < tally.firstAt) tally.firstAt = approval.at;
      if (approval.at > tally.lastAt) tally.lastAt = approval.at;
    }

    // Separation of duty, checked against the record rather than assumed from
    // the code. The submission that this approval acted on is the last one
    // before it on the same page.
    const submitted = (submissionsByPage.get(page.pageId) ?? []).filter((s) => s.eventId < approval.eventId).pop();
    if (!submitted) {
      separationUnknown += 1;
      continue;
    }
    separationChecked += 1;
    if (submitted.actorId === approval.approverId) {
      selfApproved.push({
        pageId: page.pageId,
        title: page.title,
        type: page.type,
        approverId: approval.approverId,
        approverName: actorName(db, approval.approverId),
        approvedAt: approval.at,
        refusedAtSubmission: TYPE_RULES[page.type].requiresApprover,
      });
    }
  }

  // The denominator every per-person statement is a fraction of: marks Canon
  // can attribute, not pages in the population. A page holding the mark with no
  // approval event behind it is counted separately and named, and dividing by
  // it would put a page nobody granted into everybody's share.
  const marks = input.pages.length - marksWithoutApprovalEvent;

  const standingOf = (id: string, granted: number, firstAt: string | null, lastAt: string | null): ApproverStanding => {
    const entry = rosterById.get(id) ?? null;
    const origin = originOf(entry);
    const withheld = !input.namesGroups && Boolean(entry?.groups.length);
    const groups = withheld ? [] : (entry?.groups ?? []);
    const collectionAdmin = entry?.role === 'admin';
    return {
      actorId: id,
      name: actorName(db, id),
      marks: granted,
      firstAt,
      lastAt,
      role: entry?.role ?? null,
      mayApproveNow: entry !== null,
      collectionAdmin,
      origin,
      groups,
      statement:
        (granted === 0
          ? 'Holds a role permitting approval here and granted none of the marks counted. '
          : `Granted ${granted} of the ${marks} mark(s) counted. `) +
        (collectionAdmin
          ? 'They also administer this collection, so they may change who approves in it, including by granting ' +
            'the role to themselves — an act Canon audits but does not prevent. '
          : '') +
        originSentence(origin, entry?.groups ?? [], withheld),
    };
  };

  const granters = [...marksBy.entries()]
    .map(([id, t]) => standingOf(id, t.marks, t.firstAt, t.lastAt))
    .sort((a, b) => b.marks - a.marks || a.name.localeCompare(b.name));

  const dormant = roster
    .filter((r) => !marksBy.has(r.actorId))
    .map((r) => standingOf(r.actorId, 0, null, null))
    .sort((a, b) => a.name.localeCompare(b.name));

  const grantersWithoutTheRoleNow = granters.filter((g) => !g.mayApproveNow).length;
  const groupsWithheld = Boolean(
    !input.namesGroups && [...granters, ...dormant].some((p) => rosterById.get(p.actorId)?.groups.length),
  );

  return {
    collectionId,
    at: input.at,
    population: input.population,
    marks,
    marksWithoutApprovalEvent,
    granters,
    dormant,
    eligible: roster.length,
    grantersWithoutTheRoleNow,
    selfApproved,
    separationChecked,
    separationUnknown,
    groupsWithheld,
    headline: headlineFor(marks, granters, roster.length),
    notes: notesFor({
      marks,
      marksWithoutApprovalEvent,
      granters,
      dormant,
      eligible: roster.length,
      grantersWithoutTheRoleNow,
      selfApproved,
      separationChecked,
      separationUnknown,
      groupsWithheld,
    }),
    limits: CONCENTRATION_LIMITS,
    truncated: input.truncated ?? false,
  };
}

function actorName(db: DatabaseSync, id: string): string {
  const row = db.prepare('SELECT name FROM actors WHERE id = ?').get(id) as { name: string } | undefined;
  // An actor id in history whose actor row is gone: the same case attestation.ts
  // renders as "(unknown actor …)". The id is still the attribution.
  return row?.name ?? `(unknown actor ${id})`;
}

/**
 * The sentence a reader reads first. It states the ratio and nothing else —
 * every word of it is a count, and there is no adjective anywhere in it.
 */
function headlineFor(marks: number, granters: ApproverStanding[], eligible: number): string {
  if (marks === 0) {
    return eligible === 0
      ? 'No page in this population holds a Canonical mark Canon can attribute, and nobody holds a role permitting ' +
        'approval in this collection.'
      : `No page in this population holds a Canonical mark Canon can attribute. ${eligible} person(s) hold a role ` +
        'permitting approval here.';
  }
  const people = granters.length;
  const opening =
    people === 1
      ? `All ${marks} Canonical mark(s) in this population were granted by ONE person, ${granters[0]!.name}.`
      : `${marks} Canonical mark(s) in this population were granted by ${people} people: ` +
        `${granters.map((g) => `${g.name} (${g.marks})`).join(', ')}.`;
  const denominator =
    eligible === 0
      ? ' Nobody holds a role permitting approval in this collection today, so every one of those grants was made ' +
        'by somebody who has since lost the role.'
      : people >= eligible
        ? ` ${eligible} person(s) hold a role permitting approval here, so the work was spread across everybody ` +
          'who could have done it.'
        : ` ${eligible} person(s) hold a role permitting approval here, so ${eligible - people} of them granted ` +
          'none of these marks.';
  return opening + denominator;
}

function notesFor(c: {
  marks: number;
  marksWithoutApprovalEvent: number;
  granters: ApproverStanding[];
  dormant: ApproverStanding[];
  eligible: number;
  grantersWithoutTheRoleNow: number;
  selfApproved: SelfApprovedMark[];
  separationChecked: number;
  separationUnknown: number;
  groupsWithheld: boolean;
}): string[] {
  const notes: string[] = [];

  // Where the authority came from. This is the sentence the finding asked for,
  // and it is written three ways because the three are genuinely different
  // situations for the person reading it.
  if (c.granters.length) {
    const held = c.granters.filter((g) => g.mayApproveNow);
    const byHand = held.filter((g) => g.origin === 'hand');
    const byGroup = held.filter((g) => g.origin === 'group');
    const byBoth = held.filter((g) => g.origin === 'hand_and_group');
    if (held.length && byGroup.length === held.length) {
      notes.push(
        'Every person who granted a mark here holds the role through your directory group mapping. This ' +
          'concentration follows from that mapping rather than from anything done in Canon: it is a property of ' +
          'the groups your identity provider maintains, and it will change when they do, without anybody touching ' +
          'this collection.',
      );
    } else if (held.length && byHand.length === held.length) {
      notes.push(
        'Every person who granted a mark here was given the role BY HAND, in Canon, by an administrator. No group ' +
          'mapping produced this: somebody chose these people one at a time, and each choice is a ' +
          '`collection.member_set` event in the audit log with the granting administrator’s name and the date on it.',
      );
    } else if (held.length) {
      const unrecorded = held.filter((g) => g.origin === 'unrecorded');
      notes.push(
        `Of the ${held.length} person(s) who granted marks here and still hold the role, ${byHand.length} were ` +
          `granted it by hand in Canon, ${byGroup.length} hold it through your directory group mapping, and ` +
          `${byBoth.length} hold it both ways. A mixed origin is worth a look on its own: a hand grant sitting ` +
          'underneath a group grant survives the removal of the group, silently.' +
          (unrecorded.length
            ? ` ${unrecorded.length} hold a role neither table accounts for, which should not be possible and is ` +
              'named per person below.'
            : ''),
      );
    }
  }

  if (c.grantersWithoutTheRoleNow > 0) {
    notes.push(
      `${c.grantersWithoutTheRoleNow} of the people who granted marks counted here hold NO role in this ` +
        'collection today. That is ordinary — people move on — and it is named because the "out of how many" ' +
        'figure beside it describes today’s roster and not the roster as it was when they approved. Canon does ' +
        'not version membership and cannot show you the roster of that day.',
    );
  }

  if (c.dormant.length) {
    notes.push(
      `${c.dormant.length} person(s) hold a role permitting approval here and granted none of these marks: ` +
        `${c.dormant.map((d) => d.name).join(', ')}. A right to approve that is never exercised is still a right ` +
        'to approve; whether that is intended is a question for whoever granted it.',
    );
  }

  const admins = c.granters.filter((g) => g.collectionAdmin);
  if (admins.length) {
    notes.push(
      `${admins.length} person(s) who granted marks here also administer this collection ` +
        `(${admins.map((a) => a.name).join(', ')}). An administrator may grant and withdraw the approve role, ` +
        'including their own, so their authority to approve here is not independent of them. Canon audits every ' +
        'such grant and does not prevent it — SECURITY.md states that as the residual it is.',
    );
  }

  // Separation of duty. Stated as a check that was RUN, with its denominator,
  // because "we found none" and "we did not look" read identically otherwise.
  if (c.selfApproved.length === 0) {
    notes.push(
      c.separationChecked === 0
        ? 'Canon compared the person who granted each mark against the person who submitted the draft it ' +
          'published, and found no submission to compare against on any of them. Nothing was checked and nothing ' +
          'is claimed.'
        : `Canon compared the person who granted each mark against the person who submitted the draft it ` +
          `published, on ${c.separationChecked} of the ${c.marks} mark(s): none was approved by the person who ` +
          'put it forward.',
    );
  } else {
    const uncovered = c.selfApproved.filter((s) => !s.refusedAtSubmission).length;
    notes.push(
      `Of the ${c.separationChecked} mark(s) compared, ${c.selfApproved.length} ` +
        `${c.selfApproved.length === 1 ? 'was' : 'were'} approved by the same person who submitted the draft. ${
          uncovered === c.selfApproved.length
            ? 'Every one of them is on a type that names no approver — a Plan — where Canon’s submit-time refusal ' +
              'does not apply and any holder of the approve role may accept. That is a gap in the control, not a ' +
              'breach of it, and this is the report that shows it.'
            : 'Canon refuses a draft submitted by its own NAMED approver, so any row here on a Policy or a Spec ' +
              'should not exist and is a fact about the record worth chasing rather than a fact about the person.'
        }`,
    );
  }

  if (c.separationUnknown > 0) {
    notes.push(
      `${c.separationUnknown} mark(s) carry no submission event before the approval, so no comparison was made ` +
        'for them. They are counted as unknown rather than as passing: a page seeded, imported, or published ' +
        'through a path that did not go through review has no submitter for Canon to compare against.',
    );
  }

  if (c.marksWithoutApprovalEvent > 0) {
    notes.push(
      `${c.marksWithoutApprovalEvent} page(s) in this population hold the mark with NO page.approve event naming ` +
        'the version that stands on them. That should not happen. It is reported rather than dropped, because a ' +
        'mark nobody is recorded as granting is either a page that reached Canonical by a path that did not audit ' +
        'itself or a log with a hole in it, and both are worth more than a rounding difference in a count.',
    );
  }

  if (c.groupsWithheld) {
    notes.push(
      'At least one role above came from a directory group whose NAME is not shown to you. Naming somebody else’s ' +
        'group is an operator’s question here (`GET /actors/:id/access`), and this report does not widen it. The ' +
        'fact that the role is mapped rather than hand-granted is shown either way.',
    );
  }

  return notes;
}

/**
 * What this view cannot establish. It travels with the counts, in record health
 * and in every register attestation, for the same reason EFFECTIVE_DATE_LIMITS
 * does: the claim and the caveat must not be able to drift apart.
 */
export const CONCENTRATION_LIMITS: string[] = [
  'This is a set of counts, not a judgement. Canon does not score a concentration and will not: whether it is ' +
    'acceptable that these people granted these marks depends on the size of the team, on what the material is, ' +
    'and on what your organisation wrote down about who may approve what — none of which is in this record. Two ' +
    'approvers out of two is not better or worse than two out of nine; it is a different fact, and both are here ' +
    'so a person can tell them apart.',
  'The roster is TODAY’S. Canon does not version collection membership: `collection_members` holds who may ' +
    'approve now, and the approvals beside it happened whenever they happened. A person who approved fifty pages ' +
    'and left last month appears with no role, and a person granted the role this morning appears in the ' +
    'denominator as though they had always had it. Where those two disagree, the audit log holds every ' +
    '`collection.member_set` with its date and is the only place the roster of a past day can be reconstructed.',
  'A grant that follows from a directory group is shown as one, and that is a statement about how the role ' +
    'reached Canon — not about whether the group is the right group. Canon applies the mapping in ' +
    'CANON_GROUP_MAP and re-evaluates it on every confirmation of a session; who belongs to the group, and ' +
    'whether that group should carry approval rights over this material, are answered at your identity provider ' +
    'and nowhere in here.',
  'Separation of duty is compared between the person who GRANTED the mark and the person who SUBMITTED the draft ' +
    'for review. It is not a claim that the approver did not write the text: a draft can be edited by anyone ' +
    'holding the page lock before it is submitted, and Canon enforces its rule at the point of submission ' +
    'because that is the act that puts work in front of an approver. The audit log holds every `draft.start` if ' +
    'you want to go further than Canon does.',
  'Canon counts the marks Canon holds. An approval given in a meeting, over email, or in the system this record ' +
    'was migrated from is not here, and a page imported already-Canonical carries no approval event for this ' +
    'view to attribute. Those pages are counted and named, not silently omitted.',
];
