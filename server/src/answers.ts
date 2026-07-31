import type { DatabaseSync } from 'node:sqlite';
import { Actor, CanonError, PageStatus } from './model.js';
import { STOPWORDS } from './embeddings.js';
import { ANSWERABLE_STATUSES, type RetrievalService } from './retrieval.js';

// Grounded answers: step 4 of DATA-BACKBONE.md §5, and the Epic D promise in
// CORE-PLAN.md. Generation happens under the record's rules, and the rules are
// enforced here rather than trusted to whatever generates the prose:
//
//   * Canonical pages only. Never a Draft, never a Note, never an archived
//     page. Retrieval is asked for Canonical material and the result is
//     checked again before anything is cited.
//   * Permission-filtered per asker, in the SQL of every candidate query, so
//     material the asker cannot see never influences the answer.
//   * Every answer carries at least one citation. Not "should": an answer
//     with no citations cannot be constructed, because the answer text is
//     composed from cited passages and nothing else.
//   * Refusal is a correct answer. When the filtered, expanded context does
//     not answer the question, the response is refused with an empty citation
//     list — the response we would rather ship than a plausible guess.
//
// Every ask lands in the audit log, refusals included.

export interface Citation {
  pageId: string;
  title: string;
  version: number;
  snippet: string;
}

export type RefusalReason = 'no_canonical_match';

// The answer contract from DATA-BACKBONE.md §5, used by Canon's own question
// box, by agents, and — when it lands — by Studio apps through the Knowledge
// API. One shape, one set of rules.
export interface AnswerResponse {
  answer: string | null;
  citations: Citation[];
  refused: boolean;
  reason?: RefusalReason;
  /**
   * The cited pages that are past their review date (status Needs Update).
   * Present only when there is at least one, so an answer drawn entirely from
   * current pages carries no extra noise — and so the shape every existing
   * caller reads is unchanged. The answer text says the same thing in words;
   * this is the machine-readable half, for a UI that wants to flag it.
   */
  pastReview?: { pageId: string; title: string }[];
}

export interface AskRequest {
  question: string;
  collectionId?: string;
  limit?: number;
}

// A passage handed to the generator: verbatim text from one published,
// Canonical version, with the identity a citation needs.
export interface AnswerPassage {
  pageId: string;
  title: string;
  version: number;
  text: string;
  /**
   * The standing of the page the passage came from. Optional so a generator can
   * be exercised without one; when it says `needs_update`, the page is past its
   * review date and the generator is expected to say so rather than quietly
   * present it as current.
   */
  status?: PageStatus;
}

export interface GeneratedAnswer {
  answer: string;
  citedPageIds: string[]; // must be a subset of the passages offered
}

// The seam a real model plugs into later. A generator receives the question
// and the permitted, Canonical passages, and returns prose plus the pages it
// actually used — or null when the passages do not answer the question. It
// never receives anything the asker may not see, and anything it cites that
// was not offered is dropped by the caller.
export interface AnswerGenerator {
  readonly name: string;
  generate(input: { question: string; passages: AnswerPassage[] }): GeneratedAnswer | null;
}

// How many passages an answer may draw on.
export const MAX_CITED_PASSAGES = 3;

// The default generator is extractive and honest about it: it quotes the most
// relevant passages verbatim and attributes each one. It invents nothing, it
// paraphrases nothing, and it makes no external call — so it is not a
// stand-in for a language model and does not pretend to be one. It exists so
// that the whole answer path — retrieval, permissions, citation, refusal,
// audit — is real and testable before any model is wired in, and so that the
// invariant "no claim without a citation" is structural rather than a prompt
// instruction.
export const extractiveGenerator: AnswerGenerator = {
  name: 'extractive-v1',
  generate({ passages }) {
    const usable = passages.filter((p) => p.text.trim().length > 0);
    if (usable.length === 0) return null;
    // A passage from a page past its review date is attributed as such, in the
    // answer itself. The reader is told what the record is and how old the
    // promise behind it is, in the same sentence — which is the whole point of
    // citing a Needs Update page rather than hiding it.
    const lines = usable.map(
      (p) => `“${p.text.trim()}” — ${p.title} (version ${p.version}${p.status === 'needs_update' ? ', past review' : ''})`,
    );
    const stale = usable.filter((p) => p.status === 'needs_update');
    const notice = stale.length
      ? `\n\nNote: ${stale.length === 1 ? 'one of these pages is' : `${stale.length} of these pages are`} past ` +
        'the review date its owner set, and marked Needs Update. It is still the official record; it has not been re-approved recently.'
      : '';
    return {
      answer: `The record says:\n\n${lines.join('\n\n')}${notice}`,
      citedPageIds: usable.map((p) => p.pageId),
    };
  },
};

// Retrieval always returns its best candidates, because ranking has no notion
// of "good enough" — a question sharing one common word with a page ("what is
// our policy on submarine procurement" against a retention *policy*) still
// ranks that page first, since it is the best of what exists. Answering from
// it would be the confident wrong answer CORE-PLAN §7 names as costing more
// than many right ones earn.
//
// So being retrieved is not sufficient to be cited. At least one directly
// retrieved page must also be *about* the question, measured as overlap with
// the question's content terms. Pages pulled in by graph expansion are exempt:
// a child procedure legitimately answers in words the question never used, and
// it earns its place through the anchor that reached it, not on its own.
//
// The gate is deliberately blunt and deliberately strict. It costs recall on
// oddly-worded questions, and buys refusal instead of invention — the trade
// DATA-BACKBONE.md §5 asks for.
export const MIN_TOPICAL_OVERLAP = 0.5;

// Enough of a stemmer to survive plurals and tense: records/record,
// policies/policy, retained/retain. Not linguistics — just the difference
// between a gate that works on real questions and one that refuses everything.
function stem(term: string): string {
  if (term.length > 4 && term.endsWith('ies')) return `${term.slice(0, -3)}y`;
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (term.length > suffix.length + 3 && term.endsWith(suffix)) return term.slice(0, -suffix.length);
  }
  return term;
}

function contentTerms(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    seen.add(stem(raw));
  }
  return [...seen];
}

function termsCovered(questionTerms: string[], text: string): number {
  const found = new Set(contentTerms(text));
  let covered = 0;
  for (const term of questionTerms) {
    if (found.has(term)) {
      covered += 1;
      continue;
    }
    // Prefix match catches the pairs the stemmer misses (retention/retained)
    // without matching on two or three shared letters.
    for (const candidate of found) {
      const shorter = term.length <= candidate.length ? term : candidate;
      const longer = term.length <= candidate.length ? candidate : term;
      if (shorter.length >= 5 && longer.startsWith(shorter)) {
        covered += 1;
        break;
      }
    }
  }
  return covered;
}

// Is this candidate actually about the question? Coverage of at least half the
// question's content terms, and never on the strength of a single shared word
// unless the question itself was a single word.
export function isOnTopic(question: string, text: string): boolean {
  const questionTerms = contentTerms(question);
  if (questionTerms.length === 0) return false;
  const covered = termsCovered(questionTerms, text);
  const minimum = questionTerms.length === 1 ? 1 : 2;
  return covered >= minimum && covered / questionTerms.length >= MIN_TOPICAL_OVERLAP;
}

// The minimal slice of CanonStore this service needs; CanonStore satisfies it.
export interface AnswerHost {
  getActor(id: string): Actor;
}

function now(): string {
  return new Date().toISOString();
}

export class AnswerService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly host: AnswerHost,
    private readonly retrieval: RetrievalService,
    private readonly generator: AnswerGenerator = extractiveGenerator,
  ) {}

  async ask(actorId: string, request: AskRequest): Promise<AnswerResponse> {
    const actor = this.host.getActor(actorId);
    const question = request.question?.trim();
    if (!question) throw new CanonError('invalid', 'An answer requires a question');

    const candidates = await this.retrieval.retrieve(actorId, {
      question,
      collectionId: request.collectionId,
      limit: request.limit,
      canonicalOnly: true, // Canonical pages only, enforced in the candidate SQL
      expand: true, // multi-hop: the policy states the rule, its child procedure the steps
    });

    // Belt and braces over the SQL filter: nothing outside the answerable
    // statuses, and nothing that is a Note, can reach the generator, whatever
    // retrieval returns.
    //
    // MAY A GROUNDED ANSWER CITE A NEEDS UPDATE PAGE? Yes, and it must say so.
    //
    // The case against is the obvious one: Canonical is the boundary of what the
    // suite will act on (DATA-BACKBONE.md §4), and a page past its review date
    // has, by the record's own admission, not been checked lately.
    //
    // The case for, which wins:
    //
    // 1. Nothing has replaced it. A Needs Update page is a page that WAS
    //    approved, still has an owner, and is still the only official answer the
    //    record holds. Dropping it does not give the asker a better answer; it
    //    gives them "the record is silent" about a policy that plainly exists.
    //    That is not caution, it is a false statement about the record.
    // 2. Refusing would make the feature punish honesty. Setting a review date
    //    is a voluntary promise to re-read a page. If the reward for making that
    //    promise is that the page vanishes from answers the day it comes due,
    //    the rational move is never to set a review date — and freshness dies of
    //    its own incentives. The whole point of FEATURES.md §3 is that stale
    //    knowledge ANNOUNCES itself; announcing is not the same as disappearing.
    // 3. The honest thing is available and cheap. The answer can carry the page
    //    AND its standing: the generator marks the passage "past review", the
    //    response carries `pastReview`, and the reader decides. CORE-PLAN.md §7
    //    warns against the confident wrong answer — a cited, dated, flagged
    //    quotation is the opposite of one.
    //
    // Two limits keep this from widening: an archived page is still gone (it
    // left the record deliberately), and a Draft or a Note still cannot be cited
    // at all. Needs Update is the only addition, and only because it is the one
    // status that means "Canonical, and overdue" rather than "not Canonical".
    const eligible = candidates.filter(
      (c) => ANSWERABLE_STATUSES.includes(c.status) && c.type !== 'note' && c.passage.trim().length > 0,
    );

    // The topical gate. A directly retrieved candidate must be about the
    // question to anchor an answer; expanded neighbours ride on the anchor
    // that reached them, and are dropped when their anchor does not clear.
    const anchors = eligible.filter((c) => c.via === null && isOnTopic(question, `${c.title} ${c.passage}`));
    const anchored = new Set(anchors.map((c) => c.pageId));
    const passages: AnswerPassage[] = (
      anchors.length === 0 ? [] : eligible.filter((c) => c.via === null ? anchored.has(c.pageId) : anchored.has(c.via.fromPageId))
    )
      .slice(0, MAX_CITED_PASSAGES)
      .map((c) => ({ pageId: c.pageId, title: c.title, version: c.version, text: c.passage, status: c.status }));

    const generated = passages.length > 0 ? this.generator.generate({ question, passages }) : null;

    // Citations are built from the passages the generator was given, matched
    // by page id — a generator cannot cite a page it was not offered, and an
    // answer that cites nothing is refused rather than returned.
    const citations: Citation[] = [];
    for (const pageId of generated?.citedPageIds ?? []) {
      const passage = passages.find((p) => p.pageId === pageId);
      if (!passage || citations.some((c) => c.pageId === pageId)) continue;
      citations.push({
        pageId: passage.pageId,
        title: passage.title,
        version: passage.version,
        snippet: passage.text,
      });
    }

    if (!generated || !generated.answer.trim() || citations.length === 0) {
      this.audit(actor, question, request.collectionId ?? null, true, []);
      return { answer: null, citations: [], refused: true, reason: 'no_canonical_match' };
    }

    this.audit(
      actor,
      question,
      request.collectionId ?? null,
      false,
      citations.map((c) => c.pageId),
    );
    // Which of the cited pages are past review, named so a caller does not have
    // to parse the prose. Omitted entirely when none are.
    const pastReview = passages
      .filter((p) => p.status === 'needs_update' && citations.some((c) => c.pageId === p.pageId))
      .map((p) => ({ pageId: p.pageId, title: p.title }));
    return {
      answer: generated.answer,
      citations,
      refused: false,
      ...(pastReview.length ? { pastReview } : {}),
    };
  }

  // Answers are agent-facing as well as person-facing, so every ask is on the
  // record: who asked, what they asked, whether the record answered, and
  // exactly which pages were cited.
  private audit(
    actor: Actor,
    question: string,
    collectionId: string | null,
    refused: boolean,
    citedPageIds: string[],
  ): void {
    this.db
      .prepare(
        `INSERT INTO audit_events (at, actor_id, actor_kind, action, collection_id, page_id, details_json)
         VALUES (?, ?, ?, 'answer.ask', ?, NULL, ?)`,
      )
      .run(
        now(),
        actor.id,
        actor.kind,
        collectionId,
        JSON.stringify({ question, refused, citedPageIds, generator: this.generator.name }),
      );
  }
}
