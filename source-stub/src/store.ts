import { setTimeout as sleep } from 'node:timers/promises';
import {
  ANY_PLAN,
  Behaviour,
  BenefitsError,
  Entitlement,
  HEALTHY,
  LookupAnswer,
  PLAN_SELECTORS,
  Plan,
  PlanSelector,
  SELECTOR_UNITS,
} from './model.js';

// In-memory state. A stub's record is disposable by design: every
// demonstration starts from a clean benefits administrator, seeds the plans
// and entitlements it needs, and drives resolution live. Nothing here needs
// to survive a restart, and nothing here is Canon's record — that is the
// whole point of federating instead of copying.

function now(): string {
  return new Date().toISOString();
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BenefitsError('invalid', `${field} must be a non-empty string`);
  }
  return value.trim();
}

function requireMoney(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new BenefitsError('invalid', `${field} must be a non-negative number of whole dollars`);
  }
  return value;
}

function requirePercent(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new BenefitsError('invalid', `${field} must be a percentage between 0 and 100`);
  }
  return value;
}

function requireDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new BenefitsError('invalid', `${field} must be an ISO date, YYYY-MM-DD`);
  }
  return value;
}

function isSelector(value: string): value is PlanSelector {
  return (PLAN_SELECTORS as readonly string[]).includes(value);
}

export class BenefitsStore {
  private readonly plans = new Map<string, Plan>();
  private readonly entitlements = new Map<string, Set<string>>();
  private behaviourState: Behaviour = { ...HEALTHY };

  // ---- administrative face ----------------------------------------------
  // The real benefits administrator is fed by HR and by the carrier; the stub
  // is fed by these, so tests and demonstrations can put it in a known state.

  seedPlan(input: Record<string, unknown>): Plan {
    const plan: Plan = {
      planId: requireString(input.planId, 'planId'),
      name: requireString(input.name, 'name'),
      deductible: requireMoney(input.deductible, 'deductible'),
      outOfPocketMaximum: requireMoney(input.outOfPocketMaximum, 'outOfPocketMaximum'),
      genericCoinsurance: requirePercent(input.genericCoinsurance, 'genericCoinsurance'),
      brandCoinsurance: requirePercent(input.brandCoinsurance, 'brandCoinsurance'),
      effectiveDate: requireDate(input.effectiveDate, 'effectiveDate'),
      updatedAt: now(),
    };
    this.plans.set(plan.planId, plan);
    return plan;
  }

  listPlans(): Plan[] {
    return [...this.plans.values()].sort((a, b) => a.planId.localeCompare(b.planId));
  }

  // Entitlements are the source's own access model, and they are the reason
  // this stub exists in the shape it does. `['*']` means every plan; anything
  // else is the exact set of plan ids this caller may look up. A caller that
  // was never granted anything holds the empty set.
  setEntitlements(asker: string, input: Record<string, unknown>): Entitlement {
    const who = requireString(asker, 'asker');
    const plans = input.plans;
    if (!Array.isArray(plans) || plans.some((p) => typeof p !== 'string' || !p.trim())) {
      throw new BenefitsError('invalid', 'plans must be an array of non-empty strings, or ["*"]');
    }
    const set = new Set((plans as string[]).map((p) => p.trim()));
    this.entitlements.set(who, set);
    return { asker: who, plans: [...set].sort() };
  }

  listEntitlements(): Entitlement[] {
    return [...this.entitlements.entries()]
      .map(([asker, plans]) => ({ asker, plans: [...plans].sort() }))
      .sort((a, b) => a.asker.localeCompare(b.asker));
  }

  // ---- injected failure modes -------------------------------------------

  setBehaviour(input: Record<string, unknown>): Behaviour {
    const next: Behaviour = { ...this.behaviourState };
    if (input.delayMs !== undefined) {
      if (typeof input.delayMs !== 'number' || !Number.isFinite(input.delayMs) || input.delayMs < 0) {
        throw new BenefitsError('invalid', 'delayMs must be a non-negative number');
      }
      next.delayMs = input.delayMs;
    }
    if (input.failStatus !== undefined) {
      if (input.failStatus === null) {
        next.failStatus = null;
      } else if (typeof input.failStatus !== 'number' || input.failStatus < 400 || input.failStatus > 599) {
        throw new BenefitsError('invalid', 'failStatus must be an HTTP error status, or null to recover');
      } else {
        next.failStatus = input.failStatus;
      }
    }
    this.behaviourState = next;
    return { ...next };
  }

  get behaviour(): Behaviour {
    return { ...this.behaviourState };
  }

  // ---- lookup face (called by Canon's connector) -------------------------

  /**
   * The whole of Canon's dependency: a value, by key and selector, for a
   * named caller. There is no other way in. Note what this signature cannot
   * express — a question, a ranking, a page of results — because that is the
   * capability argument of DATA-BACKBONE.md §6 made concrete.
   */
  async lookup(asker: unknown, key: unknown, selector: unknown): Promise<LookupAnswer> {
    // The injected modes sit in front of everything, because a system that is
    // down is down for authorised callers too.
    if (this.behaviourState.delayMs > 0) await sleep(this.behaviourState.delayMs);
    if (this.behaviourState.failStatus !== null) {
      throw new BenefitsError(
        'source_failure',
        `Benefits administration is failing on purpose (${this.behaviourState.failStatus})`,
        { injected: true },
        this.behaviourState.failStatus,
      );
    }

    if (typeof asker !== 'string' || !asker.trim()) {
      throw new BenefitsError('no_asker', 'This system answers no one anonymously; name the caller in X-Asker');
    }
    const who = asker.trim();

    if (typeof key !== 'string' || !key.trim()) {
      throw new BenefitsError('invalid', 'A plan id is required in `key`');
    }
    const planId = key.trim();

    if (typeof selector !== 'string' || !selector.trim()) {
      throw new BenefitsError('invalid', 'A field name is required in `selector`');
    }
    const field = selector.trim();

    // Entitlement is checked against the requested key BEFORE existence, so a
    // caller cannot map the plan catalogue by watching 403s turn into 404s.
    if (!this.entitled(who, planId)) {
      throw new BenefitsError('not_entitled', `${who} is not entitled to plan ${planId}`, { asker: who });
    }

    const plan = this.plans.get(planId);
    if (!plan) {
      throw new BenefitsError('unknown_plan', `No such plan: ${planId}`);
    }
    if (!isSelector(field)) {
      throw new BenefitsError('unknown_selector', `No such field: ${field}`, {
        known: [...PLAN_SELECTORS],
      });
    }

    return {
      key: plan.planId,
      selector: field,
      value: plan[field],
      unit: SELECTOR_UNITS[field],
      asOf: plan.updatedAt,
      system: 'benefits-admin',
    };
  }

  entitled(asker: string, planId: string): boolean {
    const grants = this.entitlements.get(asker);
    if (!grants) return false;
    return grants.has(ANY_PLAN) || grants.has(planId);
  }
}
