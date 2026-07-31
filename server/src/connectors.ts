import { ActorKind, CanonError } from './model.js';
import type { Source } from './sources.js';

// Federation, part two: the seam an integration plugs into
// (DATA-BACKBONE.md §6, "The shapes"), parallel to the embedding provider in
// §5 and held to the same discipline:
//
//   - a hermetic default, so the whole system and the whole test suite run
//     with no external calls;
//   - a real connector configured per deployment, registered by source kind;
//   - failure that degrades VISIBLY rather than silently substituting a guess.
//
// The contract is the document's, verbatim in shape:
//
//     resolve(source, request: { selector, key, asker }) -> { value, resolvedAt }
//
// It is async because a real connector does network I/O; the hermetic default
// resolves immediately. Nothing else in federation learns which it got.

/**
 * Who is asking. Present for a `per_asker` source, whose resolution carries
 * the asking actor's identity into the source system so the source decides
 * what they may see — this is what stops Canon becoming a permission-laundering
 * machine. Null for a `service` source, which resolves once with the
 * deployment's own account, publishing the value to the collection.
 */
export interface Asker {
  actorId: string;
  kind: ActorKind;
  name: string;
  email: string | null;
  /** The Agent Passport reference for an agent asker; null for a person. */
  registryRef: string | null;
}

export interface ResolveRequest {
  /** What to ask the source for: a field, endpoint, or query name. */
  selector: string;
  /** The page-held identifier to ask it with (the plan id, the claim number). */
  key: string;
  asker: Asker | null;
}

export interface ResolveResult {
  value: unknown;
  /** ISO timestamp of the moment the source answered. */
  resolvedAt: string;
}

export interface Connector {
  /** Matches `source.kind`; the registry keys on it. */
  readonly kind: string;
  resolve(source: Source, request: ResolveRequest): Promise<ResolveResult>;
}

// Connectors register themselves by kind, so adding a real integration is a
// `register()` call at start-up and touches nothing in this file's logic and
// nothing in references.ts.
export class ConnectorRegistry {
  private readonly byKind = new Map<string, Connector>();

  register(connector: Connector): this {
    this.byKind.set(connector.kind, connector);
    return this;
  }

  has(kind: string): boolean {
    return this.byKind.has(kind);
  }

  kinds(): string[] {
    return [...this.byKind.keys()].sort();
  }

  // A source whose kind has no connector is a visible failure, never a
  // silent empty value: 503, the same code Canon uses when the Registry is
  // unreachable, because in both cases the honest answer is "not right now".
  get(kind: string): Connector {
    const connector = this.byKind.get(kind);
    if (!connector) {
      throw new CanonError('unavailable', `No connector is registered for source kind '${kind}'`, {
        kind,
        registered: this.kinds(),
      });
    }
    return connector;
  }
}

export const STATIC_KIND = 'static';

/**
 * A fixture value. A function form lets a fixture observe the request — which
 * is how a `per_asker` source's asker pass-through is asserted — and lets a
 * fixture throw, which is how a source outage is exercised.
 */
export type StaticValue = unknown | ((request: ResolveRequest, source: Source) => unknown);

/** selector -> key -> value. */
export type StaticFixtureSet = Record<string, Record<string, StaticValue>>;

// THIS IS A TEST DOUBLE, NOT AN INTEGRATION. It talks to nobody. It exists so
// that Canon runs, and the whole suite runs, with no external calls, no API
// key, and no company data leaving the machine — the same bargain the local
// embedding provider makes in embeddings.ts. It is not a cache, not an
// offline mode, and not a fallback for a real connector: nothing here ever
// stands in for a source that failed, because inventing a value is precisely
// the failure mode federation exists to prevent.
//
// Fixture data is supplied per source: `kind: 'static'` and a `baseUrl` naming
// a fixture set, with or without the `static:` prefix (`static:benefits` and
// `benefits` name the same set).
export class StaticConnector implements Connector {
  readonly kind = STATIC_KIND;
  private readonly sets = new Map<string, StaticFixtureSet>();

  /** Registers (or replaces) a fixture set by name. */
  define(name: string, set: StaticFixtureSet): this {
    this.sets.set(fixtureName(name), set);
    return this;
  }

  clear(name?: string): void {
    if (name === undefined) this.sets.clear();
    else this.sets.delete(fixtureName(name));
  }

  async resolve(source: Source, request: ResolveRequest): Promise<ResolveResult> {
    const name = fixtureName(source.baseUrl);
    const set = this.sets.get(name);
    if (!set) {
      throw new CanonError('not_found', `No static fixture set named '${name}'`, { sourceId: source.id });
    }
    const bySelector = set[request.selector];
    if (!bySelector || !(request.key in bySelector)) {
      throw new CanonError(
        'not_found',
        `Static source '${source.name}' has no value for ${request.selector}/${request.key}`,
        { sourceId: source.id, selector: request.selector, key: request.key },
      );
    }
    const entry = bySelector[request.key] as StaticValue;
    const value = typeof entry === 'function' ? (entry as (r: ResolveRequest, s: Source) => unknown)(request, source) : entry;
    return { value, resolvedAt: new Date().toISOString() };
  }
}

function fixtureName(baseUrl: string): string {
  const trimmed = (baseUrl ?? '').trim();
  return trimmed.startsWith(`${STATIC_KIND}:`) ? trimmed.slice(STATIC_KIND.length + 1) : trimmed;
}

/**
 * The registry a store gets when a deployment configures nothing: the
 * hermetic default only. A deployment registers its real connectors on this
 * registry (or supplies its own) before constructing the store.
 */
export function defaultConnectorRegistry(): ConnectorRegistry {
  return new ConnectorRegistry().register(new StaticConnector());
}

/** The hermetic connector on a registry, for defining fixtures. */
export function staticConnectorOf(registry: ConnectorRegistry): StaticConnector {
  const connector = registry.get(STATIC_KIND);
  if (!(connector instanceof StaticConnector)) {
    throw new CanonError('invalid', `The '${STATIC_KIND}' connector has been replaced`);
  }
  return connector;
}
