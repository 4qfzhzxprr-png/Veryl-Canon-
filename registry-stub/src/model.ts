// Veryl Agent Registry stub — model per REGISTRY-CONTRACT.md.
// This is the test double Canon's Epic D is built and demonstrated against.
// It implements exactly the contract's endpoints and semantics, no more.

// The fixed action vocabulary (REGISTRY-CONTRACT.md §4). Canon rejects
// actions it does not recognize; the Registry refuses to store them.
export type PermittedAction = 'read' | 'comment' | 'write';
export const PERMITTED_ACTIONS: readonly PermittedAction[] = ['read', 'comment', 'write'];

// Stored certification state. `lapsed` is never stored: it is derived from
// a certified state whose expiry has passed (see effectiveState).
export type StoredCertState = 'pending' | 'certified' | 'revoked';
export type EffectiveCertState = StoredCertState | 'lapsed';

export interface Certification {
  state: StoredCertState;
  certifiedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  reason: string | null;
}

export interface AgentRecord {
  agentId: string;
  name: string;
  passport: string; // stored for lookup; returned once at registration, never listed
  certification: Certification;
  permittedCollections: string[];
  // The Canon source ids this agent may resolve references from
  // (REGISTRY-CONTRACT.md §4). Opaque strings, `"*"` for all, `[]` for none —
  // the same shape and the same default as permittedCollections, because a
  // federated source is governed exactly like a collection.
  permittedSources: string[];
  permittedActions: PermittedAction[];
  createdAt: string;
}

// The administrative view of an agent: no passport, effective state reported.
export interface AgentView {
  agentId: string;
  name: string;
  certification: Omit<Certification, 'state'> & { state: EffectiveCertState };
  permittedCollections: string[];
  permittedSources: string[];
  permittedActions: PermittedAction[];
  createdAt: string;
}

// The verification answer Canon acts on (REGISTRY-CONTRACT.md §6).
export interface Verification {
  agentId: string;
  name: string;
  certified: true;
  permittedCollections: string[];
  permittedSources: string[];
  permittedActions: PermittedAction[];
  checkedAt: string;
  recheckAfterSeconds: number;
}

// The Registry's ceiling on how long Canon may act on a verification
// without re-asking. Canon applies the smaller of this and its own
// sixty-second maximum; both are 60 here, which is the point.
export const RECHECK_AFTER_SECONDS = 60;

export type ErrorCode =
  | 'invalid'
  | 'not_found'
  | 'unknown_passport'
  | 'certification_lapsed'
  | 'revoked'
  | 'conflict';

const HTTP_STATUS: Record<ErrorCode, number> = {
  invalid: 400,
  not_found: 404,
  unknown_passport: 404,
  certification_lapsed: 403,
  revoked: 403,
  conflict: 409,
};

export class RegistryError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'RegistryError';
    this.code = code;
    this.httpStatus = HTTP_STATUS[code];
    this.details = details;
  }
}
