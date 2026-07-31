// The shapes this app exchanges with Veryl Canon's Knowledge API
// (STUDIO-CONTRACT.md §6), declared here rather than imported from Canon.
//
// That is deliberate. A Studio app is an outside caller: it holds a passport,
// it speaks HTTP, and it knows nothing of Canon's internals. If this file
// imported Canon's types the stub would stop being a proof that the contract
// is sufficient and start being a proof that the contract plus a shared
// codebase is sufficient — which is not a thing a design partner can build on.

/** One citation: the page and version a claim came from, in the record's words. */
export interface Citation {
  pageId: string;
  title: string;
  version: number;
  snippet: string;
}

/** The answer contract, one shape, from DATA-BACKBONE.md §5. */
export interface Answer {
  answer: string | null;
  citations: Citation[];
  refused: boolean;
  reason?: string;
}

export interface SearchHit {
  pageId: string;
  title: string;
  collectionId: string;
  type: string;
  status: string;
  ownerId: string | null;
  snippet: string;
}

export interface CollectionSummary {
  id: string;
  name: string;
  description: string;
}

/** What `GET /knowledge/whoami` reports: the intersection as it stands now. */
export interface Whoami {
  app: {
    actorId: string;
    registryRef: string;
    name: string;
    permittedCollections: string[];
    permittedActions: string[];
    permittedSources: string[];
  };
  person: { actorId: string; name: string };
  collections: { id: string; name: string; appRole: string; personRole: string; role: string }[];
  evaluatedAt: string;
}

/**
 * A refusal from Canon, carried whole. The app never converts one into an
 * answer, a default, or an empty result: a refusal is information, and the
 * person asking is entitled to know which of the three gates closed.
 */
export class KnowledgeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'KnowledgeError';
  }

  /** Which side refused, where Canon said so: `person`, `app`, or the Registry. */
  get refusedBy(): string | null {
    const by = this.details.refusedBy;
    if (typeof by === 'string') return by;
    const reason = this.details.reason;
    return typeof reason === 'string' && reason.startsWith('collection_') ? 'registry' : null;
  }
}
