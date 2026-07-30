import type { DatabaseSync } from 'node:sqlite';
import { Actor, CanonError } from './model.js';
import type { RetrievalService } from './retrieval.js';

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
    const lines = usable.map((p) => `“${p.text.trim()}” — ${p.title} (version ${p.version})`);
    return {
      answer: `The record says:\n\n${lines.join('\n\n')}`,
      citedPageIds: usable.map((p) => p.pageId),
    };
  },
};

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

    // Belt and braces over the SQL filter: nothing that is not a Canonical,
    // non-Note page can reach the generator, whatever retrieval returns.
    const passages: AnswerPassage[] = candidates
      .filter((c) => c.status === 'canonical' && c.type !== 'note' && c.passage.trim().length > 0)
      .slice(0, MAX_CITED_PASSAGES)
      .map((c) => ({ pageId: c.pageId, title: c.title, version: c.version, text: c.passage }));

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
    return { answer: generated.answer, citations, refused: false };
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
