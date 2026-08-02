import type { DatabaseSync } from 'node:sqlite';
import { devAuthEnabled } from './auth.js';
import type { ActorKind } from './model.js';

// How identity was established — the sentence every attestation was missing.
//
// ---------------------------------------------------------------------------
// WHY THIS FILE EXISTS
//
// USER-TESTING.md T3.1. An external auditor searched every bundle Canon
// produces for any statement of how the people named in it had been
// authenticated, and found none. On the deployment she was reviewing the dev
// door was open (`CANON_DEV_AUTH=true`), so she could act as any of four
// different people at will, and she created a SECOND actor called "Nadia
// Haddad" carrying the real Nadia's email address. Canon shouts about that door
// at start-up and in the web UI. The artefact a regulator is actually handed
// said nothing about it at all — and the hash chain then protected the false
// attribution faithfully, exactly as it protects a true one, because a chain
// attests to what the log says and takes no view on whether it is true.
//
// The gap is not the chain's and it is not fixable by a stronger chain. It is
// this: a bundle asserted WHO did something and never said HOW THAT NAME WAS
// ESTABLISHED. A reader holding the file could not tell a federated deployment
// from an open one, and had to come and ask us. That is the one thing an
// evidence artefact must never require.
//
// ---------------------------------------------------------------------------
// WHAT IS ANSWERED, AND FROM WHERE
//
// Two different questions, and they can disagree, which is the whole reason
// both are here:
//
//   THE DOORS, read from this deployment's configuration. Is single sign-on
//   configured, and against which issuer? Is the dev door open right now? An
//   open dev door means every attribution in the record — including one made
//   through a verified sign-in years ago — can be produced today by anybody who
//   can reach the port. That fact belongs on the face of the document.
//
//   THE ACTORS, read from THE RECORD ITSELF rather than from configuration.
//   `actors.sso_subject` holds `issuer#subject` for every person Canon
//   provisioned from a verified ID token (auth.ts `provision`), and holds
//   nothing for an actor created any other way — seeded, imported, or minted
//   through the dev door's `POST /actors`. So for each person named in a
//   bundle, Canon can say whether an identity provider ever vouched for them,
//   and name the issuer that did. The record answers, not the environment,
//   which matters because the environment describes today and a bundle
//   describes a history.
//
// The second is what closes the "second Nadia Haddad" hole precisely: the
// impostor has no subject, the real Nadia has one, and the bundle prints the
// difference beside both names instead of leaving a reader to compare two
// identical-looking rows.
//
// ---------------------------------------------------------------------------
// WHAT THIS DOES NOT ESTABLISH
//
// Federation is not proof that a person did a thing. It is proof that an
// identity provider Canon was configured to trust asserted a subject, and that
// Canon verified the signature over that assertion. Whoever held that account
// — including somebody who borrowed it, and including an administrator at the
// provider who can impersonate anybody — is who the record names. Canon says
// which of those two worlds a bundle came from and nothing more, because
// nothing more is true.

/** How Canon came to believe an actor is who the record says they are. */
export type IdentityBasis =
  /** A verified OpenID Connect ID token from the named issuer (auth.ts). */
  | 'federated'
  /** Named in a header or created by hand. Nothing was verified. */
  | 'asserted'
  /** An Agent Passport, verified with the Veryl Agent Registry (agentauth.ts). */
  | 'agent_passport'
  /** Canon itself, acting on its own clock. Nobody signs in as it (system.ts). */
  | 'canon_itself';

/** Which doors this deployment has open, and what that costs a reader. */
export interface IdentityDoors {
  mode: 'sso' | 'sso_with_dev_door' | 'dev' | 'closed';
  /** The OIDC issuer this deployment is configured against, or null. */
  issuer: string | null;
  ssoConfigured: boolean;
  /** `CANON_DEV_AUTH=true`: `X-Actor-Id` is believed and nothing is checked. */
  devAuthOpen: boolean;
  /** A Registry is configured, so an Agent Passport can be verified. */
  agentRegistryConfigured: boolean;
  /** The sentence that goes on the face of the document. */
  statement: string;
}

/** One actor named in a bundle, and how their name got there. */
export interface ActorIdentity {
  actorId: string;
  name: string;
  kind: ActorKind;
  basis: IdentityBasis;
  /** The issuer that vouched for this actor, as recorded at their sign-in. */
  issuer: string | null;
  /**
   * The provider's subject identifier for this person, as recorded at sign-in.
   * An identifier, never a credential: it is what lets a reader match this
   * actor to a row in their own directory, which is the check that would have
   * separated the real Nadia Haddad from the second one.
   */
  subject: string | null;
  /** Plain English, for a reader who will not switch on `basis`. */
  statement: string;
}

/** The whole answer, carried in every manifest and rendered on every face. */
export interface IdentityProvenance {
  doors: IdentityDoors;
  actors: ActorIdentity[];
  federated: number;
  asserted: number;
  /** The one sentence a reader must not have to ask us for. */
  statement: string;
  /** What this section does not establish. Extends the bundle's exclusions. */
  limits: string[];
}

const DEV_DOOR_SENTENCE =
  'IDENTITY IN THIS DEPLOYMENT WAS ASSERTED AND NOT VERIFIED. Canon is running with CANON_DEV_AUTH=true, so any ' +
  'caller who can reach it may name any actor in this record in an X-Actor-Id header and act as them, and nothing ' +
  'about that claim is checked. Read every attribution in this document as "the record says this actor did it", ' +
  'never as "this person did it".';

/**
 * Which doors are open. Read from the environment, because that is where the
 * answer lives; `devAuthEnabled` is imported from auth.ts rather than
 * re-spelled here so the door a bundle describes and the door api.ts actually
 * honours can never be two different questions.
 */
export function identityDoors(env: NodeJS.ProcessEnv = process.env): IdentityDoors {
  const issuer = (env.CANON_OIDC_ISSUER ?? '').trim().replace(/\/+$/, '') || null;
  const devAuthOpen = devAuthEnabled(env);
  const agentRegistryConfigured = Boolean((env.CANON_REGISTRY_URL ?? '').trim());
  const mode: IdentityDoors['mode'] = issuer
    ? devAuthOpen
      ? 'sso_with_dev_door'
      : 'sso'
    : devAuthOpen
      ? 'dev'
      : 'closed';
  const statement = issuer
    ? devAuthOpen
      ? `Single sign-on is configured against the OpenID Connect issuer ${issuer}, AND ${DEV_DOOR_SENTENCE} ` +
        'The open door is the weaker of the two and is therefore the one that governs: a name in this document ' +
        'may have arrived through either.'
      : `Identity was established by single sign-on. Canon verified an ID token signed by the OpenID Connect ` +
        `issuer ${issuer} — signature against that issuer's published keys, issuer, audience, expiry and nonce — ` +
        'before it would create a session, and it re-confirms every live session with that issuer at least once ' +
        'a minute. Canon attests to what the provider asserted about a subject; it does not attest to who was at ' +
        'the keyboard.'
    : devAuthOpen
      ? DEV_DOOR_SENTENCE
      : 'No door for people is open on this deployment: single sign-on is not configured (CANON_OIDC_ISSUER is ' +
        'unset) and the dev door is closed, so nobody can sign in at all. The actors named in this document were ' +
        'established at some earlier point, under a configuration this document cannot see. Each actor below ' +
        'carries what the record itself holds about how they were established.';
  return { mode, issuer, ssoConfigured: Boolean(issuer), devAuthOpen, agentRegistryConfigured, statement };
}

interface ActorRow {
  id: string;
  kind: ActorKind;
  name: string;
  registryRef: string | null;
  ssoSubject: string | null;
}

/**
 * `sso_subject` is added by auth.ts on the first start with the people-facing
 * door assembled, not by db.ts's schema — so a record that has never had
 * `PersonAuth` constructed against it does not have the column, and asking for
 * it would be a SQL error rather than an answer. Checked rather than assumed:
 * the absence of the column is itself a fact ("nobody has ever signed in to
 * this record") and reads correctly as `asserted` for every actor.
 */
function hasSubjectColumn(db: DatabaseSync): boolean {
  const columns = db.prepare('PRAGMA table_info(actors)').all() as { name: string }[];
  return columns.some((c) => c.name === 'sso_subject');
}

/** Split `issuer#subject` as auth.ts's `subjectKey` writes it. */
export function splitSubjectKey(key: string): { issuer: string | null; subject: string } {
  const cut = key.indexOf('#');
  if (cut < 0) return { issuer: null, subject: key };
  return { issuer: key.slice(0, cut) || null, subject: key.slice(cut + 1) };
}

function statementFor(row: ActorRow, doors: IdentityDoors, issuer: string | null, subject: string | null): string {
  switch (basisFor(row)) {
    case 'canon_itself':
      return 'Canon itself, acting on its own clock. There is no identity to establish and nobody can sign in as it.';
    case 'agent_passport':
      return doors.agentRegistryConfigured
        ? 'An agent. Its identity is an Agent Passport presented per request and verified with the Veryl Agent ' +
          'Registry, which is the authority for what it is and what it may do; Canon holds no credential for it ' +
          `and stores only the Registry reference ${row.registryRef ?? '(none recorded)'}.`
        : 'An agent registered in this record, but NO Agent Registry is configured on this deployment ' +
          '(CANON_REGISTRY_URL is unset), so no passport can be verified here and this actor cannot have acted ' +
          'through the agent door under the present configuration.';
    case 'federated':
      return (
        `Federated. This actor was provisioned from a verified ID token and the record holds the provider's own ` +
        `subject identifier for them (${subject}) against the issuer ${issuer ?? '(not recorded)'}. Match that ` +
        'subject against your directory to confirm which human being this is.' +
        (doors.devAuthOpen
          ? ' The dev door is nonetheless open on this deployment, so anybody who can reach the port can also act ' +
            'as this actor without signing in.'
          : '')
      );
    case 'asserted':
      return (
        'Asserted, not verified. The record holds no identity-provider subject for this actor, so no provider has ' +
        'ever vouched for them here: the actor was created by hand, seeded, imported, or minted through the dev ' +
        'door. The name and any email on it are what somebody typed.' +
        (doors.ssoConfigured
          ? ' Single sign-on IS configured on this deployment, which makes this actor an exception to it and worth ' +
            'a question.'
          : '')
      );
  }
}

function basisFor(row: ActorRow): IdentityBasis {
  if (row.kind === 'system') return 'canon_itself';
  if (row.kind === 'agent') return 'agent_passport';
  return row.ssoSubject ? 'federated' : 'asserted';
}

/**
 * How each of these actors was established, read out of the record.
 *
 * Unknown ids are answered rather than dropped: an actor id that appears in
 * history whose row is gone is exactly the case attestation.ts already renders
 * as "(unknown actor …)", and a missing row establishes nothing, which is a
 * fact worth printing rather than a reason to omit a name.
 */
export function actorIdentities(
  db: DatabaseSync,
  actorIds: readonly string[],
  doors: IdentityDoors,
): ActorIdentity[] {
  const subjects = hasSubjectColumn(db);
  const select = db.prepare(
    subjects
      ? 'SELECT id, kind, name, registry_ref, sso_subject FROM actors WHERE id = ?'
      : 'SELECT id, kind, name, registry_ref, NULL AS sso_subject FROM actors WHERE id = ?',
  );
  const out: ActorIdentity[] = [];
  const seen = new Set<string>();
  for (const actorId of actorIds) {
    if (!actorId || seen.has(actorId)) continue;
    seen.add(actorId);
    const found = select.get(actorId) as Record<string, unknown> | undefined;
    if (!found) {
      out.push({
        actorId,
        name: `(unknown actor ${actorId})`,
        kind: 'person',
        basis: 'asserted',
        issuer: null,
        subject: null,
        statement:
          'This actor id appears in the history but the record no longer holds an actor row for it. History is ' +
          'append-only and names its actor; the actor table is not. Nothing establishes who this was beyond the ' +
          'id itself.',
      });
      continue;
    }
    const row: ActorRow = {
      id: found.id as string,
      kind: found.kind as ActorKind,
      name: found.name as string,
      registryRef: (found.registry_ref as string) ?? null,
      ssoSubject: (found.sso_subject as string) ?? null,
    };
    const split = row.ssoSubject ? splitSubjectKey(row.ssoSubject) : null;
    const issuer = split?.issuer ?? null;
    const subject = split?.subject ?? null;
    out.push({
      actorId: row.id,
      name: row.name,
      kind: row.kind,
      basis: basisFor(row),
      issuer,
      subject,
      statement: statementFor(row, doors, issuer, subject),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * What this section does not establish. These sit beside the bundle's other
 * exclusions rather than inside a footnote: naming what an artefact cannot
 * support is the habit the audit credited, and identity is where the habit was
 * missing.
 */
export const IDENTITY_LIMITS: string[] = [
  'Federation establishes that an identity provider asserted a subject and that Canon verified the signature ' +
    'over that assertion. It does not establish that the person named was at the keyboard: a borrowed account, a ' +
    'shared credential, or an administrator at the provider who can impersonate a user all produce a record that ' +
    'looks exactly like an honest one here.',
  'Names in this record are not unique and are not identity. Two actors may carry the same name and the same ' +
    'email address; the actor id is the only identifier this record guarantees is distinct, and the provider ' +
    'subject printed beside a federated actor is the only identifier that means anything outside Canon.',
  'Email addresses are deliberately absent from this bundle, so an actor cannot be matched to a person by address ' +
    'here. That is a disclosure rule, not an omission — a bundle travels to readers outside the collection — and ' +
    'it means matching an actor to your own directory is done on the provider subject or not at all.',
  'Canon states how identity was established for the actors it names. It cannot state how the ORGANIZATION ' +
    'established that those people were entitled to the roles they held: a group mapping from the provider, a ' +
    'grant made by an administrator, and a grant made through the dev door are all just membership rows here.',
];

/**
 * The whole identity answer for one bundle. Called by attestation.ts with every
 * actor the bundle names; the doors are read from the environment unless a
 * caller supplies them, which is what makes this testable without a process.
 */
export function identityProvenance(
  db: DatabaseSync,
  actorIds: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): IdentityProvenance {
  const doors = identityDoors(env);
  const actors = actorIdentities(db, actorIds, doors);
  const federated = actors.filter((a) => a.basis === 'federated').length;
  const asserted = actors.filter((a) => a.basis === 'asserted').length;
  const people = actors.filter((a) => a.kind === 'person').length;
  const census =
    people === 0
      ? 'No person is named in this document.'
      : asserted === 0
        ? `All ${people} person(s) named here were provisioned from a verified sign-in.`
        : federated === 0
          ? `NONE of the ${people} person(s) named here was provisioned from a verified sign-in: the record holds ` +
            'no identity-provider subject for any of them.'
          : `${federated} of the ${people} person(s) named here were provisioned from a verified sign-in; ` +
            `${asserted} were not, and are marked below.`;
  return {
    doors,
    actors,
    federated,
    asserted,
    statement: `${doors.statement} ${census}`,
    limits: IDENTITY_LIMITS,
  };
}
