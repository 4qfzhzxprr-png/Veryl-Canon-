// Benefits administration stub — model per DATA-BACKBONE.md §6.
//
// This is the test double Canon's federation is built and demonstrated
// against: a *record system*, not a document store. It owns facts nobody
// argues about — the deductible, the out-of-pocket maximum, the coinsurance
// split — and it will keep owning them. Canon never copies them; a page
// holds the plan id and the value is resolved when the page is read.
//
// Two properties of the real thing are reproduced deliberately, because they
// are the two that decide whether federation works at all:
//
// - It answers by KEY AND SELECTOR only. There is no ranking, no free-text
//   query, no way to enumerate the corpus through the lookup face. "You
//   cannot rank what you cannot enumerate", so semantic retrieval over this
//   system is a dead end and the stub refuses to pretend otherwise
//   (GET /search answers 501, on purpose).
// - It has its own access model, and it enforces it per caller. Resolve
//   everything through one service account and Canon becomes a
//   permission-laundering machine; this stub is what proves Canon does not,
//   because it will hand a caller a 403 for a plan that caller is not
//   entitled to see, whatever Canon believes.

// The fixed selector vocabulary: the fields a benefits policy page would
// actually reference. A selector this system does not recognise is a 404,
// never a guess.
export const PLAN_SELECTORS = [
  'deductible',
  'outOfPocketMaximum',
  'genericCoinsurance',
  'brandCoinsurance',
  'effectiveDate',
] as const;

export type PlanSelector = (typeof PLAN_SELECTORS)[number];

export type SelectorUnit = 'USD' | 'percent' | 'date';

export const SELECTOR_UNITS: Record<PlanSelector, SelectorUnit> = {
  deductible: 'USD',
  outOfPocketMaximum: 'USD',
  genericCoinsurance: 'percent',
  brandCoinsurance: 'percent',
  effectiveDate: 'date',
};

export interface Plan {
  planId: string;
  name: string;
  deductible: number; // whole USD, per member per year
  outOfPocketMaximum: number; // whole USD, per member per year
  genericCoinsurance: number; // percent the member pays, 0–100
  brandCoinsurance: number; // percent the member pays, 0–100
  effectiveDate: string; // ISO date, YYYY-MM-DD
  updatedAt: string;
}

// What a lookup answers with. `value` is the only field a connector is
// required to understand; the rest is context a resolved reference can carry
// into a citation ("$1,500, resolved from Benefits Admin at 09:14").
export interface LookupAnswer {
  key: string;
  selector: PlanSelector;
  value: string | number;
  unit: SelectorUnit;
  asOf: string; // when this system last changed the plan, not when we asked
  system: 'benefits-admin';
}

// The wildcard entitlement: this caller may look up any plan. Anything else
// is an explicit list of plan ids.
export const ANY_PLAN = '*';

export interface Entitlement {
  asker: string;
  plans: string[];
}

// The two injected failure modes. They exist so a connector's degradation can
// be exercised honestly rather than asserted: a source that is slow and a
// source that is broken are different failures with different handling, and
// neither may ever become an invented value.
export interface Behaviour {
  /** Milliseconds every lookup waits before answering. /health is unaffected. */
  delayMs: number;
  /** When set, every lookup fails with this status instead of answering. */
  failStatus: number | null;
}

export const HEALTHY: Behaviour = { delayMs: 0, failStatus: null };

// The header naming the asking actor. Canon sends the asker's own identity
// for a `per_asker` source and its configured service identity for a
// `service` one; this system does not care which, only that someone is named.
export const ASKER_HEADER = 'x-asker';

export type ErrorCode =
  | 'invalid'
  | 'no_asker'
  | 'not_entitled'
  | 'unknown_plan'
  | 'unknown_selector'
  | 'not_supported'
  | 'source_failure';

const HTTP_STATUS: Record<ErrorCode, number> = {
  invalid: 400,
  no_asker: 401,
  not_entitled: 403,
  unknown_plan: 404,
  unknown_selector: 404,
  not_supported: 501,
  source_failure: 500,
};

export class BenefitsError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details: Record<string, unknown>;

  // `status` overrides the code's usual status, and exists for exactly one
  // caller: the injected failure mode, which must be able to break this
  // system with whatever status a test wants to put a connector through.
  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}, status?: number) {
    super(message);
    this.name = 'BenefitsError';
    this.code = code;
    this.httpStatus = status ?? HTTP_STATUS[code];
    this.details = details;
  }
}
