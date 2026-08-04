import { randomBytes, randomUUID } from 'node:crypto';
import {
  AgentRecord,
  AgentView,
  Certification,
  EffectiveCertState,
  PERMITTED_ACTIONS,
  PermittedAction,
  RECHECK_AFTER_SECONDS,
  RegistryError,
  Verification,
} from './model.js';

// In-memory state. A stub's record is disposable by design: every M3
// demonstration starts from a clean Registry, registers its agents, and
// drives the lifecycle live. Nothing here needs to survive a restart.

function now(): string {
  return new Date().toISOString();
}

function issuePassport(): string {
  return `vap_${randomBytes(24).toString('hex')}`;
}

function parseActions(value: unknown, fallback: PermittedAction[]): PermittedAction[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) {
    throw new RegistryError('invalid', 'permittedActions must be an array');
  }
  for (const action of value) {
    if (!PERMITTED_ACTIONS.includes(action as PermittedAction)) {
      throw new RegistryError('invalid', `Unknown action: ${String(action)}. Permitted: ${PERMITTED_ACTIONS.join(', ')}`);
    }
  }
  return [...new Set(value as PermittedAction[])];
}

// Collection ids and source ids are governed alike (REGISTRY-CONTRACT.md §4),
// so they parse alike: opaque non-empty strings, deduplicated, `"*"` carried
// through as the entry meaning all, absent meaning "leave as it was".
function parseIds(value: unknown, fallback: string[], field: 'permittedCollections' | 'permittedSources'): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.some((c) => typeof c !== 'string' || !c.trim())) {
    throw new RegistryError('invalid', `${field} must be an array of non-empty strings`);
  }
  return [...new Set((value as string[]).map((c) => c.trim()))];
}

function parseInstant(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new RegistryError('invalid', `${field} must be an ISO-8601 timestamp`);
  }
  return new Date(value).toISOString();
}

// `lapsed` is derived, never stored: certified with an expiry in the past.
export function effectiveState(certification: Certification): EffectiveCertState {
  if (certification.state === 'certified' && certification.expiresAt && Date.parse(certification.expiresAt) <= Date.now()) {
    return 'lapsed';
  }
  return certification.state;
}

export class RegistryStore {
  private readonly agents = new Map<string, AgentRecord>();
  private readonly byPassport = new Map<string, string>();

  // ---- administrative face ---------------------------------------------

  register(input: {
    name?: unknown;
    permittedCollections?: unknown;
    permittedSources?: unknown;
    permittedActions?: unknown;
  }): AgentRecord {
    if (typeof input.name !== 'string' || !input.name.trim()) {
      throw new RegistryError('invalid', 'An agent requires a name');
    }
    const record: AgentRecord = {
      agentId: randomUUID(),
      name: input.name.trim(),
      passport: issuePassport(),
      certification: { state: 'pending', certifiedAt: null, expiresAt: null, revokedAt: null, reason: null },
      permittedCollections: parseIds(input.permittedCollections, [], 'permittedCollections'),
      // Nowhere by default, sources included: where the limits are silent,
      // the agent gets less (REGISTRY-CONTRACT.md §4).
      permittedSources: parseIds(input.permittedSources, [], 'permittedSources'),
      permittedActions: parseActions(input.permittedActions, ['read']),
      createdAt: now(),
    };
    this.agents.set(record.agentId, record);
    this.byPassport.set(record.passport, record.agentId);
    return record;
  }

  private agent(agentId: string): AgentRecord {
    const record = this.agents.get(agentId);
    if (!record) throw new RegistryError('not_found', `No such agent: ${agentId}`);
    return record;
  }

  certify(agentId: string, input: { expiresAt?: unknown } = {}): AgentView {
    const record = this.agent(agentId);
    if (record.certification.state === 'revoked') {
      throw new RegistryError('conflict', 'Revocation is terminal; register a new agent');
    }
    record.certification = {
      state: 'certified',
      certifiedAt: now(),
      expiresAt: parseInstant(input.expiresAt, 'expiresAt'),
      revokedAt: null,
      reason: null,
    };
    return this.view(record);
  }

  revoke(agentId: string, input: { reason?: unknown } = {}): AgentView {
    const record = this.agent(agentId);
    if (record.certification.state !== 'revoked') {
      record.certification = {
        ...record.certification,
        state: 'revoked',
        revokedAt: now(),
        reason: typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim() : null,
      };
    }
    return this.view(record);
  }

  setPermissions(
    agentId: string,
    input: { permittedCollections?: unknown; permittedSources?: unknown; permittedActions?: unknown },
  ): AgentView {
    const record = this.agent(agentId);
    // Each field is validated before any is stored, so a rejected field never
    // leaves the record half-replaced.
    const collections = parseIds(input.permittedCollections, record.permittedCollections, 'permittedCollections');
    const sources = parseIds(input.permittedSources, record.permittedSources, 'permittedSources');
    const actions = parseActions(input.permittedActions, record.permittedActions);
    record.permittedCollections = collections;
    record.permittedSources = sources;
    record.permittedActions = actions;
    return this.view(record);
  }

  list(): AgentView[] {
    return [...this.agents.values()].map((record) => this.view(record));
  }

  // The administrative view: no passport, effective state reported so an
  // administrator reads standing directly instead of doing date arithmetic.
  private view(record: AgentRecord): AgentView {
    return {
      agentId: record.agentId,
      name: record.name,
      certification: { ...record.certification, state: effectiveState(record.certification) },
      permittedCollections: [...record.permittedCollections],
      permittedSources: [...record.permittedSources],
      permittedActions: [...record.permittedActions],
      createdAt: record.createdAt,
    };
  }

  // ---- verification face (called by Canon) ------------------------------

  verify(passport: unknown): Verification {
    if (typeof passport !== 'string' || !passport.trim()) {
      throw new RegistryError('invalid', 'A passport is required');
    }
    const agentId = this.byPassport.get(passport);
    if (!agentId) {
      throw new RegistryError('unknown_passport', 'No registered agent holds this passport');
    }
    const record = this.agent(agentId);
    const state = effectiveState(record.certification);
    if (state === 'revoked') {
      throw new RegistryError('revoked', 'Certification has been revoked', {
        revokedAt: record.certification.revokedAt,
      });
    }
    if (state !== 'certified') {
      throw new RegistryError(
        'certification_lapsed',
        state === 'pending' ? 'This agent has not earned certification' : 'Certification has expired',
      );
    }
    return {
      agentId: record.agentId,
      name: record.name,
      certified: true,
      permittedCollections: [...record.permittedCollections],
      permittedSources: [...record.permittedSources],
      permittedActions: [...record.permittedActions],
      checkedAt: now(),
      recheckAfterSeconds: RECHECK_AFTER_SECONDS,
    };
  }
}
