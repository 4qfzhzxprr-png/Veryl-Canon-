// The Studio app itself: a benefits question-answering assistant.
//
// This is the smallest honest example of the thing Veryl Studio exists to let
// anyone build — an app over company knowledge that a compliance lead can
// approve. Everything that makes it approvable is in the contract rather than
// in this file:
//
//   * It stores no company knowledge. There is no index here, no cache, no
//     copy of a page. Every question goes to Canon, live.
//   * It has no permission model. It never decides who may see what; it names
//     the person and lets Canon's three gates decide.
//   * It cannot show what the person could not have read themselves, and it
//     cannot show what it was not itself permitted to read.
//   * When the record is silent, it says so.
//
// The app's whole state is its configuration: its passport and Canon's URL.

import { KnowledgeClient } from './client.js';
import { Answer, KnowledgeError, SearchHit, Whoami } from './model.js';
import { renderAnswer, renderRefusal, renderWhoami } from './render.js';

export interface BenefitsAppOptions {
  name?: string;
  client: KnowledgeClient;
}

/** One person, as this app knows them: a Canon actor id and a display name. */
export interface Person {
  actorId: string;
  name?: string;
}

export interface AppAnswer {
  question: string;
  person: { actorId: string; name: string };
  answer: string | null;
  citations: Answer['citations'];
  refused: boolean;
  reason?: string;
  /** Set when Canon refused the call outright rather than refusing to answer. */
  error?: { status: number; code: string; message: string; refusedBy: string | null };
  rendered: string;
}

export class BenefitsApp {
  readonly name: string;
  private readonly client: KnowledgeClient;

  constructor(options: BenefitsAppOptions) {
    this.name = options.name ?? 'Benefits Assistant';
    this.client = options.client;
  }

  /**
   * Answer a benefits question for a named person.
   *
   * There are exactly three outcomes and the app is honest about which one it
   * is in: a cited answer, a refusal from the record ("it does not say"), or a
   * refusal from Canon's door ("you, or I, may not read what this needs").
   * None of them is ever prose the app made up.
   */
  async answerFor(person: Person, question: string, opts: { collectionId?: string } = {}): Promise<AppAnswer> {
    const personName = person.name ?? person.actorId;
    try {
      const answer = await this.client.ask(person.actorId, { question, collectionId: opts.collectionId });
      return {
        question,
        person: { actorId: person.actorId, name: personName },
        answer: answer.answer,
        citations: answer.citations,
        refused: answer.refused,
        ...(answer.reason ? { reason: answer.reason } : {}),
        rendered: renderAnswer({ appName: this.name, personName, question, answer }),
      };
    } catch (err) {
      if (!(err instanceof KnowledgeError)) throw err;
      return {
        question,
        person: { actorId: person.actorId, name: personName },
        answer: null,
        citations: [],
        refused: true,
        reason: err.code,
        error: { status: err.status, code: err.code, message: err.message, refusedBy: err.refusedBy },
        rendered: renderRefusal(this.name, personName, question, err),
      };
    }
  }

  /** What the app can find for this person — the same three gates, in a list. */
  find(person: Person, q: string): Promise<SearchHit[]> {
    return this.client.search(person.actorId, q);
  }

  /** The intersection, for the demonstration and for answering "why can't I see X?". */
  async context(person: Person): Promise<{ whoami: Whoami; rendered: string }> {
    const whoami = await this.client.whoami(person.actorId);
    return { whoami, rendered: renderWhoami(whoami) };
  }
}
