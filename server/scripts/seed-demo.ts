// A demo corpus for Veryl Canon.
//
// *** THIS IS A DEVELOPMENT TOOL. IT IS FOR DEMOS AND TESTS, AND IT MUST NEVER
// *** BE RUN AGAINST A DEPLOYMENT. It invents people, writes several hundred
// *** pages, grants itself membership everywhere, runs imports, registers
// *** external sources and resolves them once. Every one of those is a real
// *** write to the record with a real actor's name on it, and none of those
// *** names belong to anybody. A record with this corpus in it is a demo
// *** record and can never become a company's.
//
// Why it exists: the knowledge map is a picture of how a company's knowledge
// hangs together, and eleven pages in one collection is a picture of nothing.
// This builds what a regulated company's record actually looks like — five
// collections, trees three and four deep, every status including the awkward
// ones, material that came in from Confluence and Google Docs, pages that read
// from live systems, and links that cross collections, which is the thing a
// single-collection map can never show.
//
// DETERMINISTIC BY CONSTRUCTION. Every choice comes from a seeded PRNG below;
// `Math.random` appears nowhere. The same `--seed` produces the same corpus —
// the same collections, the same trees, the same titles, the same statuses,
// the same links — so a screenshot is reproducible and a test can assert a
// node and edge count. What is NOT stable across runs is page IDs (they are
// UUIDs) and timestamps, so the seeder never depends on either.
//
//   npm run seed:demo                     # writes ./canon.db, refuses a non-empty one
//   npm run seed:demo -- --db demo.db     # somewhere else
//   npm run seed:demo -- --seed 7         # a different, equally reproducible corpus
//   npm run seed:demo -- --force          # add it to a record that already has content
//
// Then: CANON_DEV_AUTH=true CANON_DB=demo.db npm start, and sign in as any of
// the people it prints.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { staticConnectorOf } from '../src/connectors.js';
import { openDb } from '../src/db.js';
import { GRAPH_EDGE_KINDS, type GraphEdgeKind } from '../src/graph.js';
import type { ImportSummary } from '../src/import.js';
import type { DocType, PageStatus, Role } from '../src/model.js';
import type { NotificationTransport } from '../src/notify.js';
import { CanonStore } from '../src/store.js';

// ---------------------------------------------------------------------------
// The seeded PRNG
//
// mulberry32: thirty-two bits of state, one multiply-xor-shift round, uniform
// enough for choosing a status and a title and small enough to read. It is
// here rather than imported because the whole product has zero runtime
// dependencies and a demo tool is not the place to start.

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private readonly next: () => number;

  constructor(seed: number) {
    this.next = mulberry32(seed);
  }

  /** An integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }

  /** One of `items`, chosen by weight. Weights need not sum to anything. */
  weighted<T>(items: readonly (readonly [T, number])[]): T {
    const total = items.reduce((sum, [, weight]) => sum + weight, 0);
    let roll = this.next() * total;
    for (const [item, weight] of items) {
      roll -= weight;
      if (roll <= 0) return item;
    }
    return items[items.length - 1]![0];
  }
}

// ---------------------------------------------------------------------------
// The people
//
// Invented, and obviously so. Emails are on example.com, which RFC 2606
// reserves precisely so that nothing here can ever be delivered anywhere.

interface PersonSpec {
  key: string;
  name: string;
  email: string;
  title: string;
}

const PEOPLE: PersonSpec[] = [
  { key: 'dana', name: 'Dana Whitfield', email: 'dana.whitfield@example.com', title: 'Head of Compliance' },
  { key: 'marc', name: 'Marc Oyelaran', email: 'marc.oyelaran@example.com', title: 'Compliance Analyst' },
  { key: 'nadia', name: 'Nadia Haddad', email: 'nadia.haddad@example.com', title: 'General Counsel' },
  { key: 'priya', name: 'Priya Raman', email: 'priya.raman@example.com', title: 'Benefits Manager' },
  { key: 'iris', name: 'Iris Cho', email: 'iris.cho@example.com', title: 'Member Services Lead' },
  { key: 'tomas', name: 'Tomas Lindqvist', email: 'tomas.lindqvist@example.com', title: 'Clinical Policy Director' },
  { key: 'grace', name: 'Grace Abara', email: 'grace.abara@example.com', title: 'Pharmacy Director' },
  { key: 'ada', name: 'Ada Okonkwo', email: 'ada.okonkwo@example.com', title: 'People Partner' },
  { key: 'ruth', name: 'Ruth Beaumont', email: 'ruth.beaumont@example.com', title: 'Head of People' },
  { key: 'sam', name: 'Sam Ferreira', email: 'sam.ferreira@example.com', title: 'Engineering Lead' },
  { key: 'joel', name: 'Joel Brennan', email: 'joel.brennan@example.com', title: 'Staff Engineer' },
];

/** By key, for the "who owns this" line every page body carries. */
const PERSON_BY_KEY = new Map(PEOPLE.map((person) => [person.key, person]));

// ---------------------------------------------------------------------------
// The corpus
//
// Depth 1 and depth 2 are written out by hand, because the shape of a
// company's record is not something a generator knows: a retention schedule
// under a records policy, a formulary under clinical criteria. Depth 3 comes
// from each branch's own `topics`, which are also written by hand — they are
// page titles, not filler — and depth 4 is a small, deterministic fraction of
// those given the kind of child a real branch grows: a worked example, an
// appendix, a review record.

interface BranchSpec {
  title: string;
  type: DocType;
  /** One true sentence about the page, which its body is written around. */
  purpose: string;
  /** Titles of the pages beneath it. Real titles, not generated ones. */
  topics?: string[];
  children?: BranchSpec[];
}

interface CollectionSpec {
  key: string;
  name: string;
  description: string;
  /** Who administers, who writes, who approves, who only reads. */
  admin: string;
  authors: string[];
  approver: string;
  viewers?: string[];
  /** Left off the roster on purpose, so the record has something to withhold. */
  restricted?: boolean;
  roots: BranchSpec[];
}

const COMPLIANCE: CollectionSpec = {
  key: 'compliance',
  name: 'Compliance',
  description: 'Regulatory obligations, the controls that meet them, and the evidence that they worked.',
  admin: 'dana',
  authors: ['dana', 'marc'],
  approver: 'nadia',
  viewers: ['priya', 'tomas', 'ada', 'sam'],
  roots: [
    {
      title: 'Regulatory Compliance Program',
      type: 'policy',
      purpose: 'the program under which every regulatory obligation is owned, tested, and reported on',
      children: [
        {
          title: 'Compliance Roles and Responsibilities',
          type: 'policy',
          purpose: 'who owns which obligation, and what each owner is accountable for',
          topics: [
            'Compliance Committee charter',
            'Delegated authority matrix',
            'Escalation path for a suspected breach',
            'Annual attestation process',
          ],
        },
        {
          title: 'Regulatory Change Management',
          type: 'policy',
          purpose: 'how a change in the rules becomes a change in the record',
          topics: [
            'Horizon scanning sources and cadence',
            'Impact assessment template',
            'Implementation tracking for rule changes',
          ],
        },
        {
          title: 'Annual Compliance Risk Assessment',
          type: 'plan',
          purpose: 'the yearly assessment that decides where compliance effort goes',
          topics: [
            'Risk scoring method',
            'Inherent and residual risk register',
            'Assessment timetable and owners',
          ],
        },
      ],
    },
    {
      title: 'Privacy and Data Protection',
      type: 'policy',
      purpose: 'how member and employee personal data is collected, used, shared, and protected',
      children: [
        {
          title: 'Member Data Handling Standard',
          type: 'policy',
          purpose: 'the handling rules that apply to member data wherever it is held',
          topics: [
            'Data classification and labelling',
            'Minimum necessary access rules',
            'Encryption in transit and at rest',
            'Handling data on personal devices',
          ],
        },
        {
          title: 'Privacy Impact Assessments',
          type: 'spec',
          purpose: 'when a privacy impact assessment is required and what it must contain',
          topics: [
            'PIA: member portal redesign',
            'PIA: claims data warehouse',
            'PIA: vendor analytics pilot',
            'PIA threshold questionnaire',
          ],
        },
        {
          title: 'Subject Access and Correction Requests',
          type: 'policy',
          purpose: 'how a request from a member for their own data is received, verified, and answered',
          topics: [
            'Identity verification for access requests',
            'Thirty-day response clock',
            'Redaction rules for third-party data',
          ],
        },
      ],
    },
    {
      title: 'Records and Retention',
      type: 'policy',
      purpose: 'how long each kind of record is kept, and what happens at the end of that period',
      children: [
        {
          title: 'Records Retention Schedule',
          type: 'policy',
          purpose: 'the retention period for every record class the company holds',
          topics: [
            'Retention periods: claims and appeals',
            'Retention periods: clinical criteria',
            'Retention periods: employment records',
            'Retention periods: vendor contracts',
          ],
        },
        {
          title: 'Legal Hold Procedure',
          type: 'policy',
          purpose: 'how retention is suspended when material is relevant to litigation or an investigation',
          topics: [
            'Issuing and releasing a hold',
            'Custodian notice and acknowledgement',
            'Holds on federated systems',
          ],
        },
        {
          title: 'Secure Disposal of Records',
          type: 'spec',
          purpose: 'how records are destroyed once their retention period ends, and how that is evidenced',
          topics: ['Disposal certificates', 'Disposal of backup media'],
        },
      ],
    },
    {
      title: 'Audit and Monitoring',
      type: 'plan',
      purpose: 'the testing that shows the controls in this collection actually work',
      children: [
        {
          title: 'Internal Audit Plan',
          type: 'plan',
          purpose: 'what will be audited this year, by whom, and when',
          topics: [
            'Audit universe and coverage',
            'Audit scheduling and resourcing',
            'Reporting to the Audit Committee',
          ],
        },
        {
          title: 'Control Testing Procedures',
          type: 'spec',
          purpose: 'how each control is tested, with the sample sizes and the evidence expected',
          topics: [
            'Sampling method for control tests',
            'Evidence standards for a passed test',
            'Testing controls that run in Canon',
          ],
        },
        {
          title: 'Findings and Remediation Tracking',
          type: 'spec',
          purpose: 'how a finding is recorded, owned, and closed',
          topics: ['Finding severity definitions', 'Remediation plan template', 'Overdue findings escalation'],
        },
      ],
    },
    {
      title: 'Third-Party Oversight',
      type: 'policy',
      purpose: 'the diligence and monitoring applied to vendors that touch member data or member care',
      children: [
        {
          title: 'Vendor Due Diligence',
          type: 'policy',
          purpose: 'what is checked before a vendor is engaged, and how often it is rechecked',
          topics: [
            'Pre-contract security questionnaire',
            'Vendor risk tiering',
            'Annual re-assessment cadence',
          ],
        },
        {
          title: 'Business Associate Agreements',
          type: 'policy',
          purpose: 'the contractual terms required of any vendor handling protected health information',
          topics: ['Required BAA clauses', 'BAA register and renewal dates'],
        },
      ],
    },
  ],
};

const MEMBER_BENEFITS: CollectionSpec = {
  key: 'benefits',
  name: 'Member Benefits',
  description: 'What members are entitled to, how eligibility is decided, and how disputes are handled.',
  admin: 'dana',
  authors: ['priya', 'iris', 'dana'],
  approver: 'nadia',
  viewers: ['marc', 'tomas', 'sam'],
  roots: [
    {
      title: 'Plan Documents',
      type: 'policy',
      purpose: 'the authoritative description of each plan the company administers',
      children: [
        {
          title: 'Standard Plan (PLAN-7)',
          type: 'policy',
          purpose: 'the benefits, limits, and cost sharing of the standard plan',
          topics: [
            'PLAN-7 deductible and out-of-pocket maximum',
            'PLAN-7 covered services',
            'PLAN-7 exclusions and limitations',
            'PLAN-7 network tiers',
          ],
        },
        {
          title: 'High Deductible Plan (PLAN-9)',
          type: 'policy',
          purpose: 'the benefits and cost sharing of the high deductible plan and its savings account',
          topics: [
            'PLAN-9 deductible and out-of-pocket maximum',
            'PLAN-9 preventive services before deductible',
            'PLAN-9 savings account rules',
          ],
        },
        {
          title: 'Plan Comparison and Selection',
          type: 'note',
          purpose: 'how the plans differ, in the terms members actually ask about',
          topics: ['Side-by-side plan comparison', 'Questions members ask at enrolment'],
        },
      ],
    },
    {
      title: 'Eligibility and Enrolment',
      type: 'policy',
      purpose: 'who may enrol, when, and what evidence is required',
      children: [
        {
          title: 'Eligibility Rules',
          type: 'policy',
          purpose: 'the conditions a person must meet to be covered, and when coverage begins',
          topics: [
            'Employee eligibility and waiting periods',
            'Dependent eligibility and proof',
            'Coverage effective dates',
            'Loss of eligibility and termination dates',
          ],
        },
        {
          title: 'Open Enrolment',
          type: 'plan',
          purpose: 'the annual enrolment window and everything that has to happen inside it',
          topics: [
            'Open enrolment timeline',
            'Member communications schedule',
            'Enrolment system readiness checklist',
          ],
        },
        {
          title: 'Qualifying Life Events',
          type: 'policy',
          purpose: 'the mid-year changes that let a member change plan outside open enrolment',
          topics: ['Recognised qualifying events', 'Evidence required per event', 'Retroactive coverage rules'],
        },
      ],
    },
    {
      title: 'Claims',
      type: 'spec',
      purpose: 'how a claim moves from submission to payment, and what stops it',
      children: [
        {
          title: 'Claims Processing Standard',
          type: 'spec',
          purpose: 'the processing rules, timeframes, and accuracy targets for claims',
          topics: [
            'Clean claim definition',
            'Turnaround time targets',
            'Coordination of benefits',
            'Duplicate claim detection',
          ],
        },
        {
          title: 'Claims Runbook',
          type: 'note',
          purpose: 'the day-to-day steps a claims examiner follows when something is unusual',
          topics: [
            'Pended claim triage',
            'Manual pricing overrides',
            'Reprocessing after a policy correction',
          ],
        },
      ],
    },
    {
      title: 'Appeals and Grievances',
      type: 'policy',
      purpose: 'how a member disputes a decision and how that dispute is resolved',
      children: [
        {
          title: 'Appeals Process',
          type: 'policy',
          purpose: 'the levels of appeal, who decides each, and the deadlines that bind them',
          topics: [
            'First-level appeal handling',
            'Second-level and external review',
            'Expedited appeals for urgent care',
            'Appeal acknowledgement letters',
          ],
        },
        {
          title: 'Grievance Handling',
          type: 'spec',
          purpose: 'how a complaint that is not an appeal is logged, answered, and reported',
          topics: ['Grievance categories', 'Regulatory grievance reporting'],
        },
      ],
    },
  ],
};

const CLINICAL_POLICY: CollectionSpec = {
  key: 'clinical',
  name: 'Clinical Policy',
  description: 'Coverage criteria, medical necessity, and the evidence each decision rests on.',
  admin: 'dana',
  authors: ['tomas', 'grace'],
  approver: 'nadia',
  viewers: ['priya', 'iris', 'marc'],
  roots: [
    {
      title: 'Medical Necessity Criteria',
      type: 'policy',
      purpose: 'the standard by which a service is judged medically necessary, and who may judge it',
      children: [
        {
          title: 'Criteria Development and Review',
          type: 'spec',
          purpose: 'how a criterion is written, evidenced, reviewed, and retired',
          topics: [
            'Evidence grading scale',
            'Annual criteria review cycle',
            'Retiring a superseded criterion',
          ],
        },
        {
          title: 'Imaging Criteria',
          type: 'policy',
          purpose: 'when advanced imaging is covered and what must be tried first',
          topics: ['MRI: lumbar spine', 'CT: chest', 'PET: oncology staging'],
        },
        {
          title: 'Surgical Criteria',
          type: 'policy',
          purpose: 'the criteria applied to elective surgical procedures',
          topics: ['Bariatric surgery criteria', 'Spinal fusion criteria', 'Joint replacement criteria'],
        },
      ],
    },
    {
      title: 'Prior Authorisation',
      type: 'policy',
      purpose: 'which services require authorisation before they are delivered, and how fast a decision is made',
      children: [
        {
          title: 'Prior Authorisation List',
          type: 'policy',
          purpose: 'the services that require authorisation, and the review that keeps the list current',
          topics: [
            'Services requiring authorisation',
            'Adding a service to the list',
            'Removing a service from the list',
          ],
        },
        {
          title: 'Authorisation Decision Timeframes',
          type: 'spec',
          purpose: 'the clock that runs on a standard and on an expedited authorisation',
          topics: ['Standard decision timeframe', 'Expedited decision timeframe', 'Extensions and member notice'],
        },
        {
          title: 'Peer-to-Peer Review',
          type: 'note',
          purpose: 'how a treating clinician reaches a medical director to discuss a decision',
          topics: ['Requesting a peer-to-peer', 'Documenting the discussion'],
        },
      ],
    },
    {
      title: 'Pharmacy and Formulary',
      type: 'policy',
      purpose: 'which drugs are covered, at what tier, and under what conditions',
      children: [
        {
          title: 'Formulary Management',
          type: 'policy',
          purpose: 'how the formulary is decided, changed, and communicated',
          topics: [
            'P&T Committee terms of reference',
            'Formulary change notice periods',
            'Non-formulary exception requests',
          ],
        },
        {
          title: 'Specialty Drug Policy',
          type: 'policy',
          purpose: 'the handling, authorisation, and site-of-care rules for specialty drugs',
          topics: ['Site-of-care redirection', 'Specialty pharmacy network', 'Split-fill program'],
        },
        {
          title: 'Step Therapy',
          type: 'spec',
          purpose: 'when a member must try a preferred drug first, and how that is overridden',
          topics: ['Step therapy protocols', 'Medical exception to step therapy'],
        },
      ],
    },
    {
      title: 'Utilisation Review',
      type: 'plan',
      purpose: 'the review of care as it is delivered, and what the review is measured on',
      children: [
        {
          title: 'Concurrent Review',
          type: 'spec',
          purpose: 'review of an inpatient stay while the member is still admitted',
          topics: ['Inpatient review cadence', 'Discharge planning handoff'],
        },
        {
          title: 'Retrospective Review',
          type: 'spec',
          purpose: 'review of care after it has been delivered, and what may still be denied',
          topics: ['Retrospective review triggers', 'Provider notification of findings'],
        },
      ],
    },
  ],
};

const HR: CollectionSpec = {
  key: 'hr',
  name: 'People and Workplace',
  description: 'Employment policy, the handbook, and how the people team runs its own processes.',
  admin: 'dana',
  authors: ['ada', 'ruth'],
  approver: 'nadia',
  // Deliberately narrow: the whole-record map has to have something it can
  // withhold, or the permission rule is untested by looking at it.
  restricted: true,
  roots: [
    {
      title: 'Employee Handbook',
      type: 'policy',
      purpose: 'the terms every employee is asked to read and acknowledge',
      children: [
        {
          title: 'Working Hours and Flexibility',
          type: 'policy',
          purpose: 'core hours, flexible working, and how a change is agreed',
          topics: ['Flexible working requests', 'Core hours and time zones', 'Overtime and time off in lieu'],
        },
        {
          title: 'Leave and Absence',
          type: 'policy',
          purpose: 'every kind of leave, how much of it there is, and how it is requested',
          topics: [
            'Annual leave entitlement',
            'Sick leave and certification',
            'Parental leave',
            'Compassionate and emergency leave',
          ],
        },
        {
          title: 'Code of Conduct',
          type: 'policy',
          purpose: 'the standards of behaviour expected of everyone, and what happens when they are not met',
          topics: ['Conflicts of interest', 'Gifts and hospitality', 'Speaking up and non-retaliation'],
        },
      ],
    },
    {
      title: 'Hiring',
      type: 'spec',
      purpose: 'how a role is opened, assessed, and filled',
      children: [
        {
          title: 'Interview Process',
          type: 'spec',
          purpose: 'the stages of an interview loop and what each stage is for',
          topics: ['Structured interview guide', 'Take-home exercise standards', 'Debrief and decision meeting'],
        },
        {
          title: 'Offers and Onboarding',
          type: 'plan',
          purpose: 'everything between a decision to hire and a productive first month',
          topics: ['Offer approval matrix', 'First-week onboarding plan', 'Access provisioning checklist'],
        },
      ],
    },
    {
      title: 'Performance and Development',
      type: 'policy',
      purpose: 'how performance is reviewed and how development is funded',
      children: [
        {
          title: 'Review Cycle',
          type: 'plan',
          purpose: 'the twice-yearly review, its inputs, and its timetable',
          topics: ['Review timetable', 'Calibration guidance', 'Writing useful feedback'],
        },
        {
          title: 'Learning Budget',
          type: 'policy',
          purpose: 'what the development budget may be spent on and who approves it',
          topics: ['Eligible expenses', 'Conference attendance'],
        },
      ],
    },
  ],
};

const ENGINEERING: CollectionSpec = {
  key: 'engineering',
  name: 'Engineering',
  description: 'How the platform is built and operated, and the specifications the record depends on.',
  admin: 'dana',
  authors: ['sam', 'joel'],
  approver: 'nadia',
  viewers: ['marc', 'priya'],
  roots: [
    {
      title: 'Platform Architecture',
      type: 'spec',
      purpose: 'the shape of the platform and the decisions that fixed it',
      children: [
        {
          title: 'Service Boundaries',
          type: 'spec',
          purpose: 'which service owns which data, and what may cross a boundary',
          topics: ['Claims service boundary', 'Member service boundary', 'Shared reference data'],
        },
        {
          title: 'Data Retention in the Platform',
          type: 'spec',
          purpose: 'how the retention schedule is implemented in storage, backups, and logs',
          topics: ['Retention jobs and their schedule', 'Backup expiry', 'Log retention and scrubbing'],
        },
        {
          title: 'Integration Patterns',
          type: 'spec',
          purpose: 'how the platform reaches systems it does not own',
          topics: ['Reference resolution over HTTP', 'Idempotency for outbound calls', 'Handling a source outage'],
        },
      ],
    },
    {
      title: 'Operations',
      type: 'plan',
      purpose: 'how the platform is run, watched, and recovered',
      children: [
        {
          title: 'On-call Runbook',
          type: 'note',
          purpose: 'what the person holding the pager does, in the order they should do it',
          topics: ['Paging and escalation', 'Common alerts and first checks', 'Handover at shift end'],
        },
        {
          title: 'Incident Management',
          type: 'spec',
          purpose: 'how an incident is declared, run, and written up',
          topics: ['Severity definitions', 'Incident roles', 'Blameless postmortem template'],
        },
        {
          title: 'Change and Release',
          type: 'spec',
          purpose: 'how a change reaches production and how it is backed out',
          topics: ['Release checklist', 'Rollback procedure', 'Freeze windows'],
        },
      ],
    },
    {
      title: 'Security Engineering',
      type: 'policy',
      purpose: 'the engineering controls behind the compliance obligations',
      children: [
        {
          title: 'Access Control',
          type: 'policy',
          purpose: 'how access is granted, reviewed, and removed in the platform',
          topics: ['Role definitions', 'Quarterly access review', 'Break-glass access'],
        },
        {
          title: 'Secrets and Credentials',
          type: 'spec',
          purpose: 'where secrets live and how they are rotated',
          topics: ['Secret storage', 'Rotation schedule', 'Credential incident response'],
        },
      ],
    },
    {
      title: 'Delivery Plans',
      type: 'plan',
      purpose: 'what engineering is building next, and why',
      children: [
        {
          title: 'Member Portal Redesign',
          type: 'plan',
          purpose: 'the plan for rebuilding the member-facing portal',
          topics: ['Redesign milestones', 'Migration of saved preferences', 'Accessibility acceptance criteria'],
        },
        {
          title: 'Claims Platform Modernisation',
          type: 'plan',
          purpose: 'the multi-quarter plan to replace the claims pipeline',
          topics: ['Pipeline cutover plan', 'Dual-run reconciliation'],
        },
      ],
    },
  ],
};

const COLLECTIONS: CollectionSpec[] = [COMPLIANCE, MEMBER_BENEFITS, CLINICAL_POLICY, HR, ENGINEERING];

// ---------------------------------------------------------------------------
// Bodies
//
// Written, not generated from nonsense. Each body is assembled from real
// sentences about a real subject: the page's own purpose, the collection it
// sits in, a scope section, a short list drawn from that collection's own
// vocabulary, and who to ask. Two pages never read identically, and no page
// reads like filler, which matters more than it sounds: a demo corpus of lorem
// ipsum is a demo of nothing, and a reviewer scrolling one page of it stops
// believing the rest.

const OPENINGS: Record<DocType, string[]> = {
  policy: [
    'This policy states {purpose}. It applies to everyone acting on behalf of the company, including contractors and vendors working under our direction.',
    'This policy sets out {purpose}. Where it conflicts with a local practice, this document is the one that stands.',
    'The purpose of this policy is to state {purpose}, so that the same decision is reached whoever is making it.',
  ],
  spec: [
    'This specification describes {purpose}. It is written to be implemented, so anything ambiguous here is a defect in this page rather than a matter of judgement for the reader.',
    'This document specifies {purpose}. It states what must happen; the reasoning behind it is recorded in the parent page.',
    'This specification covers {purpose}, in enough detail that two teams implementing it independently arrive at the same behaviour.',
  ],
  plan: [
    'This plan sets out {purpose}, with the dates and owners that make it real.',
    'This plan describes {purpose}. It is reviewed at each milestone and revised when a date moves, rather than quietly slipping.',
    'This plan records {purpose}, so that everyone involved is working from the same sequence.',
  ],
  note: [
    'This note records {purpose}. It is working material rather than official record — it carries no Canonical mark and should not be cited as policy.',
    'These are working notes on {purpose}. They are kept here so the reasoning is not lost, not because they have been agreed.',
    'A short note on {purpose}, written up so the next person does not have to work it out again.',
  ],
};

const SCOPE_LINES: Record<string, string[]> = {
  compliance: [
    'It applies to every regulated line of business and to the vendors that support them.',
    'It applies wherever member or employee personal data is created, stored, or shared.',
    'It applies to all records held by the company, in any system and in any format.',
  ],
  benefits: [
    'It applies to all plans the company administers and to every member enrolled in them.',
    'It applies to member-facing staff, delegated administrators, and the claims platform itself.',
    'It applies to decisions made by staff and to the same decisions made automatically.',
  ],
  clinical: [
    'It applies to every coverage decision made under the plans listed in Member Benefits.',
    'It applies to clinical reviewers, medical directors, and delegated review vendors.',
    'It applies to authorisation, concurrent review, and retrospective review alike.',
  ],
  hr: [
    'It applies to all employees, and to workers engaged through an agency where stated.',
    'It applies from the first day of employment and continues to apply through any notice period.',
    'It applies to managers making the decision as much as to the people affected by it.',
  ],
  engineering: [
    'It applies to every service in the platform, including those operated by a vendor on our behalf.',
    'It applies to production and to any environment holding real member data.',
    'It applies to changes made by people and to changes made by automation.',
  ],
};

const RULE_LINES: Record<string, string[]> = {
  compliance: [
    'Every obligation has a single named owner; an obligation owned by a team is owned by nobody.',
    'Evidence is produced as the control runs, not reconstructed before an audit.',
    'A control that cannot be tested is not a control, and is recorded as a gap.',
    'Exceptions are time-limited, written down, and reviewed at expiry rather than renewed by default.',
    'Where this record and a system disagree, the disagreement is itself a finding.',
  ],
  benefits: [
    'The plan document is the authority; a summary that contradicts it is a defect in the summary.',
    'A member is told the reason for a decision in the same letter that gives them the decision.',
    'Deadlines run from the date the member sent the request, not the date we opened it.',
    'A decision that cannot be explained to the member in two sentences is reviewed before it is sent.',
    'Cost-sharing figures are read from the benefits administrator, never retyped into this page.',
  ],
  clinical: [
    'A criterion cites the evidence it rests on, with the grade of that evidence stated.',
    'A denial is made by a clinician qualified in the relevant specialty, never by an administrator.',
    'The treating clinician can always reach a medical director to discuss a decision.',
    'Criteria are reviewed annually, and a criterion past review is marked as such rather than quietly relied on.',
    'Where criteria are silent, the case is escalated rather than decided by analogy.',
  ],
  hr: [
    'A decision that affects someone’s pay or standing is explained to them in writing.',
    'Managers apply this consistently; where consistency and fairness pull apart, the People team is asked first.',
    'Nothing here removes a statutory right, and where the law is more generous, the law applies.',
    'Requests are answered within ten working days, even when the answer is not yet final.',
  ],
  engineering: [
    'A service owns its data and exposes it through an interface, never through another service’s database.',
    'Every outbound call is idempotent or is safe to retry, and which one it is, is stated.',
    'A failure degrades visibly: no default value is ever substituted for a value that did not arrive.',
    'Changes reach production through the pipeline, and a change that bypassed it is an incident.',
    'Access is granted for a reason that is recorded, and reviewed quarterly against that reason.',
  ],
};

const CLOSINGS: string[] = [
  'Questions about this page go to its owner in the first instance.',
  'If this page is wrong, say so on the page rather than working around it — a correction is cheaper than a workaround.',
  'This page is reviewed on the date in its review field. If that date has passed, treat what follows with care.',
  'Related material sits under the parent page; the record is deliberately shallow where it can be.',
];

// ---------------------------------------------------------------------------
// Reference fields (DATA-BACKBONE.md §6): facts other systems own
//
// Small on purpose. Federation is meant to be the exception — the deductible,
// the headcount, the claim status — and a demo that federates everything would
// be teaching the wrong lesson.

interface SourceSpec {
  key: string;
  name: string;
  kind: string;
  baseUrl: string;
  authMode: 'service' | 'per_asker';
  freshnessWindowMs: number;
  collections: string[];
  fixtures: Record<string, Record<string, unknown>>;
}

const SOURCES: SourceSpec[] = [
  {
    key: 'benefits-admin',
    name: 'Benefits Admin',
    kind: 'static',
    baseUrl: 'static:benefits-admin',
    authMode: 'service',
    freshnessWindowMs: 6 * 60 * 60 * 1000,
    collections: ['benefits', 'clinical'],
    fixtures: {
      deductible: { 'PLAN-7': '$1,500 individual / $3,000 family', 'PLAN-9': '$3,200 individual / $6,400 family' },
      outOfPocketMax: { 'PLAN-7': '$6,000 individual', 'PLAN-9': '$7,500 individual' },
      networkTiers: { 'PLAN-7': 'Tier 1 preferred, Tier 2 standard, Tier 3 out of network' },
    },
  },
  {
    key: 'claims-platform',
    name: 'Claims Platform',
    kind: 'static',
    baseUrl: 'static:claims-platform',
    authMode: 'per_asker',
    freshnessWindowMs: 15 * 60 * 1000,
    collections: ['benefits'],
    fixtures: {
      turnaroundDays: { 'clean-claim': 12, 'pended-claim': 21 },
      openAppeals: { 'level-1': 34, 'level-2': 7 },
    },
  },
  {
    key: 'people-system',
    name: 'People System',
    kind: 'static',
    baseUrl: 'static:people-system',
    authMode: 'service',
    freshnessWindowMs: 24 * 60 * 60 * 1000,
    collections: ['hr'],
    fixtures: {
      headcount: { engineering: 41, compliance: 9, 'member-services': 63 },
      leaveEntitlementDays: { standard: 25, 'long-service': 30 },
    },
  },
];

/** Which page title gets which reference. Matched exactly, so a rename shows up. */
/**
 * Where the record disagrees with itself (DATA-BACKBONE.md §7). Written by
 * hand, like the cross-collection links and for the same reason: a
 * contradiction is a claim about two specific pages, and a generator picking
 * pairs would produce a map full of assertions nobody made. Every note here is
 * the sentence a person would actually write, because the note is what the
 * next person has to settle the thing from.
 *
 * All three are asserted by the operator, who administers every collection and
 * therefore holds `edit` on both ends — which asserting a relation requires.
 */
const RELATION_PLAN: {
  from: [string, string];
  to: [string, string];
  kind: 'conflicts_with' | 'supersedes';
  note?: string;
}[] = [
  {
    // The cross-collection case: the one a single-collection map cannot draw.
    from: ['compliance', 'Records Retention Schedule'],
    to: ['engineering', 'Data Retention in the Platform'],
    kind: 'conflicts_with',
    note: 'The schedule keeps claims records for seven years; the platform spec describes a deletion job that runs at twenty-four months. One of the two is wrong, and Compliance owns which.',
  },
  {
    // §7's most dangerous shape: a value contradicting the prose beside it.
    from: ['benefits', 'Standard Plan (PLAN-7)'],
    to: ['benefits', 'PLAN-7 deductible and out-of-pocket maximum'],
    kind: 'conflicts_with',
    note: 'The plan page restates the deductible in prose; the child page resolves it from Benefits Admin. When the source moved, the sentence did not, and the two now read differently.',
  },
  {
    from: ['engineering', 'Incident Management'],
    to: ['engineering', 'On-call Runbook'],
    kind: 'supersedes',
    note: 'Paging and escalation were folded into this spec when it was reviewed. The runbook is kept for its history, not for its instructions.',
  },
];

const REFERENCE_PLAN: { collection: string; title: string; source: string; selector: string; key: string }[] = [
  { collection: 'benefits', title: 'PLAN-7 deductible and out-of-pocket maximum', source: 'benefits-admin', selector: 'deductible', key: 'PLAN-7' },
  { collection: 'benefits', title: 'PLAN-7 deductible and out-of-pocket maximum', source: 'benefits-admin', selector: 'outOfPocketMax', key: 'PLAN-7' },
  { collection: 'benefits', title: 'PLAN-9 deductible and out-of-pocket maximum', source: 'benefits-admin', selector: 'deductible', key: 'PLAN-9' },
  { collection: 'benefits', title: 'PLAN-7 network tiers', source: 'benefits-admin', selector: 'networkTiers', key: 'PLAN-7' },
  { collection: 'benefits', title: 'Standard Plan (PLAN-7)', source: 'benefits-admin', selector: 'deductible', key: 'PLAN-7' },
  { collection: 'benefits', title: 'Turnaround time targets', source: 'claims-platform', selector: 'turnaroundDays', key: 'clean-claim' },
  { collection: 'benefits', title: 'Pended claim triage', source: 'claims-platform', selector: 'turnaroundDays', key: 'pended-claim' },
  { collection: 'benefits', title: 'First-level appeal handling', source: 'claims-platform', selector: 'openAppeals', key: 'level-1' },
  { collection: 'clinical', title: 'Site-of-care redirection', source: 'benefits-admin', selector: 'networkTiers', key: 'PLAN-7' },
  { collection: 'hr', title: 'Annual leave entitlement', source: 'people-system', selector: 'leaveEntitlementDays', key: 'standard' },
  { collection: 'hr', title: 'Review timetable', source: 'people-system', selector: 'headcount', key: 'engineering' },
];

/**
 * Links that cross a collection boundary, by title. Written by hand because
 * they are the point of the whole-record map: a page in Compliance that links
 * a page in Engineering is a relationship no single-collection map can draw,
 * and a generator picking pairs at random would produce a picture that means
 * nothing.
 */
const CROSS_LINKS: { from: [string, string]; to: [string, string][] }[] = [
  {
    from: ['compliance', 'Records Retention Schedule'],
    to: [
      ['engineering', 'Data Retention in the Platform'],
      ['benefits', 'Claims Processing Standard'],
    ],
  },
  {
    from: ['compliance', 'Retention periods: claims and appeals'],
    to: [['benefits', 'Appeals Process']],
  },
  {
    from: ['compliance', 'Retention periods: clinical criteria'],
    to: [['clinical', 'Criteria Development and Review']],
  },
  {
    from: ['compliance', 'Member Data Handling Standard'],
    to: [
      ['engineering', 'Access Control'],
      ['engineering', 'Secrets and Credentials'],
    ],
  },
  {
    from: ['compliance', 'PIA: member portal redesign'],
    to: [['engineering', 'Member Portal Redesign']],
  },
  {
    from: ['compliance', 'PIA: claims data warehouse'],
    to: [['engineering', 'Claims Platform Modernisation']],
  },
  {
    from: ['compliance', 'Holds on federated systems'],
    to: [['engineering', 'Integration Patterns']],
  },
  {
    from: ['compliance', 'Testing controls that run in Canon'],
    to: [['engineering', 'Change and Release']],
  },
  {
    from: ['benefits', 'Eligibility Rules'],
    to: [
      ['compliance', 'Records Retention Schedule'],
      ['hr', 'Leave and Absence'],
    ],
  },
  {
    from: ['benefits', 'Appeals Process'],
    to: [
      ['clinical', 'Prior Authorisation List'],
      ['compliance', 'Subject Access and Correction Requests'],
    ],
  },
  {
    from: ['benefits', 'Claims Processing Standard'],
    to: [
      ['engineering', 'Claims Platform Modernisation'],
      ['clinical', 'Authorisation Decision Timeframes'],
    ],
  },
  {
    from: ['benefits', 'PLAN-7 covered services'],
    to: [['clinical', 'Medical Necessity Criteria']],
  },
  {
    from: ['clinical', 'Prior Authorisation List'],
    to: [['benefits', 'Claims Processing Standard']],
  },
  {
    from: ['clinical', 'Formulary Management'],
    to: [['benefits', 'Plan Documents']],
  },
  {
    from: ['clinical', 'Criteria Development and Review'],
    to: [['compliance', 'Regulatory Change Management']],
  },
  {
    from: ['engineering', 'Data Retention in the Platform'],
    to: [['compliance', 'Records Retention Schedule']],
  },
  {
    from: ['engineering', 'Access Control'],
    to: [
      ['compliance', 'Member Data Handling Standard'],
      ['hr', 'Access provisioning checklist'],
    ],
  },
  {
    from: ['engineering', 'Integration Patterns'],
    to: [['benefits', 'Claims Processing Standard']],
  },
  {
    from: ['engineering', 'Member Portal Redesign'],
    to: [['benefits', 'Plan Comparison and Selection']],
  },
  {
    from: ['hr', 'Access provisioning checklist'],
    to: [['engineering', 'Access Control']],
  },
  {
    from: ['hr', 'Code of Conduct'],
    to: [['compliance', 'Third-Party Oversight']],
  },
];

// ---------------------------------------------------------------------------
// Building it

interface SeededPage {
  id: string;
  collectionKey: string;
  collectionId: string;
  title: string;
  type: DocType;
  purpose: string;
  depth: number;
  parentId: string | null;
  ownerKey: string;
  /** Where this page is meant to end up. `archived` is applied last. */
  target: PageStatus;
  links: string[]; // page ids, filled in before the body is written
}

export interface SeedOptions {
  seed?: number;
  /** Silence the running commentary; the report is still returned. */
  quiet?: boolean;
}

export interface SeedReport {
  seed: number;
  actors: number;
  collections: { name: string; id: string; pages: number; members: number }[];
  pages: number;
  byStatus: Record<string, number>;
  byType: Record<string, number>;
  byProvenance: Record<string, number>;
  edges: Record<GraphEdgeKind, number>;
  /** Asserted page relations: conflicts with, supersedes (DATA-BACKBONE.md §7). */
  relations: number;
  crossCollectionLinks: number;
  maxDepth: number;
  sources: number;
  references: number;
  imports: { source: string; collection: string; found: number; imported: number; failed: number }[];
  archived: number;
  graph: { collections: number; nodes: number; edges: number };
  /** actorId of the person to sign in as to see everything. */
  operatorId: string;
}

const QUIET: NotificationTransport = { deliver() {} };

function isoDate(offsetDays: number): string {
  const date = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

/** The fixtures the test suite already ships, reused as an import to migrate. */
function findFixtures(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 8; up += 1) {
    const candidate = join(dir, 'test', 'fixtures');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  return null;
}

/**
 * True when this record already holds anything. A seeder that quietly merges a
 * demo corpus into somebody's real record would be indistinguishable from a
 * data incident, so the default is to refuse and say what it found.
 */
export function recordHasContent(db: DatabaseSync): { collections: number; pages: number; actors: number } {
  const count = (table: string): number =>
    Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number } | undefined)?.n ?? 0);
  return { collections: count('collections'), pages: count('pages'), actors: count('actors') };
}

export async function seedDemo(store: CanonStore, options: SeedOptions = {}): Promise<SeedReport> {
  const seed = options.seed ?? 20260731;
  const rng = new Rng(seed);
  const say = (line: string): void => {
    if (!options.quiet) console.log(line);
  };

  // ---- people ------------------------------------------------------------
  const actors = new Map<string, string>();
  for (const person of PEOPLE) {
    const actor = store.createActor({ kind: 'person', name: person.name, email: person.email });
    actors.set(person.key, actor.id);
  }
  const operator = actors.get('dana')!;
  // Somebody has to run this Canon, and since the org-level role arrived
  // (orgrole.ts) that is a fact stated rather than inferred from administering
  // a collection. Dana is the demo record's administrator: she runs the
  // freshness sweep below, and she is the actor these tests read the whole
  // record's map through.
  store.bootstrapAdministrator(operator);
  say(`  people        ${PEOPLE.length} (Dana Whitfield is this Canon's administrator)`);

  // ---- collections and membership ---------------------------------------
  const collectionIds = new Map<string, string>();
  const memberCounts = new Map<string, number>();
  for (const spec of COLLECTIONS) {
    const collection = store.createCollection(actors.get(spec.admin)!, {
      name: spec.name,
      description: spec.description,
      restricted: spec.restricted ?? false,
    });
    collectionIds.set(spec.key, collection.id);
    const roles: [string, Role][] = [
      ...spec.authors.map((key): [string, Role] => [key, 'edit']),
      [spec.approver, 'approve'],
      ...(spec.viewers ?? []).map((key): [string, Role] => [key, 'view']),
    ];
    let members = 1; // the admin, who created it
    for (const [key, role] of roles) {
      if (key === spec.admin) continue;
      store.setMember(actors.get(spec.admin)!, collection.id, actors.get(key)!, role);
      members += 1;
    }
    memberCounts.set(spec.key, members);
  }

  // ---- the trees ---------------------------------------------------------
  // Pass one creates every page, so that pass two can write a body linking any
  // page in the record — including one in another collection, which is the
  // whole point and is impossible if bodies are written as pages are made.
  const pages: SeededPage[] = [];
  const byTitle = new Map<string, SeededPage>(); // `${collectionKey}\u0000${title}`
  const key = (collectionKey: string, title: string): string => `${collectionKey}\u0000${title}`;

  const create = (
    spec: CollectionSpec,
    title: string,
    type: DocType,
    purpose: string,
    parent: SeededPage | null,
    depth: number,
  ): SeededPage => {
    const ownerKey = spec.authors[rng.int(0, spec.authors.length - 1)]!;
    const page = store.createPage(actors.get(ownerKey)!, {
      collectionId: collectionIds.get(spec.key)!,
      parentId: parent?.id ?? null,
      type,
      title,
    });
    const seeded: SeededPage = {
      id: page.id,
      collectionKey: spec.key,
      collectionId: collectionIds.get(spec.key)!,
      title,
      type,
      purpose,
      depth,
      parentId: parent?.id ?? null,
      ownerKey,
      target: targetStatus(type, depth, rng),
      links: [],
    };
    pages.push(seeded);
    if (!byTitle.has(key(spec.key, title))) byTitle.set(key(spec.key, title), seeded);
    return seeded;
  };

  for (const spec of COLLECTIONS) {
    for (const root of spec.roots) {
      const rootPage = create(spec, root.title, root.type, root.purpose, null, 1);
      for (const branch of root.children ?? []) {
        const branchPage = create(spec, branch.title, branch.type, branch.purpose, rootPage, 2);
        for (const topic of branch.topics ?? []) {
          const leafType = rng.weighted<DocType>([
            ['note', 5],
            [branch.type, 3],
            ['spec', 2],
          ]);
          const leaf = create(spec, topic, leafType, `${lowerFirst(topic)}, as it is actually done`, branchPage, 3);
          // A fraction of leaves grow the fourth level a real record grows:
          // the worked example, the appendix, the record of a review.
          if (rng.chance(0.35)) {
            const shape = rng.pick(DEPTH_FOUR);
            create(spec, `${topic} — ${shape.suffix}`, shape.type, shape.purpose(topic), leaf, 4);
          }
        }
      }
    }
  }
  say(`  pages         ${pages.length} created across ${COLLECTIONS.length} collections`);

  // ---- links -------------------------------------------------------------
  // Two kinds, both written into published bodies where a person would write
  // them: the hand-written cross-collection links above, and a "see also"
  // within a collection, chosen deterministically among siblings and cousins.
  let crossLinks = 0;
  for (const rule of CROSS_LINKS) {
    const from = byTitle.get(key(rule.from[0], rule.from[1]));
    if (!from) continue;
    for (const [collectionKey, title] of rule.to) {
      const to = byTitle.get(key(collectionKey, title));
      if (!to || to.id === from.id) continue;
      from.links.push(to.id);
      crossLinks += 1;
    }
  }
  for (const page of pages) {
    if (!rng.chance(0.22)) continue;
    const family = pages.filter((p) => p.collectionKey === page.collectionKey && p.id !== page.id);
    if (!family.length) continue;
    const target = family[rng.int(0, family.length - 1)]!;
    if (!page.links.includes(target.id)) page.links.push(target.id);
  }

  // ---- bodies, publication, review --------------------------------------
  const byId = new Map(pages.map((page) => [page.id, page]));
  for (const page of pages) {
    const author = actors.get(page.ownerKey)!;
    const spec = COLLECTIONS.find((c) => c.key === page.collectionKey)!;
    const approver = actors.get(spec.approver)!;
    const body = bodyFor(page, rng, byId);

    if (page.target === 'draft' && page.type === 'note' && !page.links.length && rng.chance(0.3)) {
      // A note somebody started and has not published: a draft with no version
      // at all, which is a real state and the one most easily forgotten.
      store.editDraft(author, page.id, { title: page.title, body });
      continue;
    }

    const fields = {
      ownerId: author,
      approverId: page.type === 'note' ? null : approver,
      effectiveDate: page.type === 'policy' ? isoDate(-rng.int(60, 700)) : null,
      reviewDate:
        page.type === 'note'
          ? null
          : page.target === 'needs_update'
            ? isoDate(-rng.int(5, 120))
            : isoDate(rng.int(20, 400)),
    };
    store.editDraft(author, page.id, { title: page.title, body, fields });

    if (page.type === 'note' || page.target === 'draft') {
      store.publish(author, page.id, { note: 'First publication' });
      continue;
    }
    if (page.target === 'in_review') {
      // Published once, then revised and sent for review: a page with an
      // official version and a change waiting on somebody.
      store.publish(author, page.id, { note: 'First publication' });
      store.editDraft(author, page.id, { body: `${body}\n\n## Under review\n\n${rng.pick(REVISION_NOTES)}` });
      store.submitForReview(author, page.id);
      continue;
    }
    // canonical, and needs_update, which is canonical plus a review date that
    // has passed — the sweep at the end is what moves it, exactly as it would
    // in a running deployment.
    store.submitForReview(author, page.id);
    store.approve(approver, page.id, { note: 'Approved as Canonical' });
  }

  // ---- migration: material that came from somewhere else -----------------
  const imports: SeedReport['imports'] = [];
  const fixtures = findFixtures();
  if (fixtures) {
    const runs: { source: 'confluence' | 'google-docs'; path: string; collection: string }[] = [
      { source: 'confluence', path: join(fixtures, 'confluence-space'), collection: 'benefits' },
      { source: 'google-docs', path: join(fixtures, 'google-docs'), collection: 'clinical' },
    ];
    for (const run of runs) {
      if (!existsSync(run.path)) continue;
      const summary: ImportSummary = store.runImport(operator, {
        source: run.source,
        path: run.path,
        collectionId: collectionIds.get(run.collection)!,
        type: 'note',
      });
      imports.push({
        source: run.source,
        collection: COLLECTIONS.find((c) => c.key === run.collection)!.name,
        found: summary.counts.found,
        imported: summary.counts.imported,
        failed: summary.counts.failed,
      });
    }
  }

  // ---- where the record disagrees with itself (§7) ------------------------
  // Asserted, never inferred: this is a person writing down that two pages
  // contradict each other, which is the only reason the map is allowed to draw
  // it. Nothing here changes either page's status — Canon surfaces
  // contradiction, it does not resolve it.
  let relations = 0;
  for (const plan of RELATION_PLAN) {
    const from = byTitle.get(key(plan.from[0], plan.from[1]));
    const to = byTitle.get(key(plan.to[0], plan.to[1]));
    if (!from || !to || from.id === to.id) continue;
    store.assertRelation(operator, from.id, {
      toPageId: to.id,
      kind: plan.kind,
      note: plan.note ?? null,
    });
    relations += 1;
  }

  // ---- federation: facts other systems own -------------------------------
  const fixtureConnector = staticConnectorOf(store.connectors);
  const sourceIds = new Map<string, string>();
  for (const spec of SOURCES) {
    fixtureConnector.define(spec.baseUrl, spec.fixtures);
    const source = store.createSource(operator, {
      name: spec.name,
      kind: spec.kind,
      baseUrl: spec.baseUrl,
      authMode: spec.authMode,
      freshnessWindowMs: spec.freshnessWindowMs,
      collectionIds: spec.collections.map((c) => collectionIds.get(c)!),
    });
    sourceIds.set(spec.key, source.id);
  }
  let references = 0;
  const referencedPages = new Set<string>();
  for (const plan of REFERENCE_PLAN) {
    const page = byTitle.get(key(plan.collection, plan.title));
    const sourceId = sourceIds.get(plan.source);
    if (!page || !sourceId) continue;
    store.addReference(actors.get(page.ownerKey)!, page.id, {
      sourceId,
      selector: plan.selector,
      key: plan.key,
      label: `${plan.selector} (${plan.key})`,
    });
    references += 1;
    referencedPages.add(page.id);
  }
  // Resolved once, here, so the demo record carries a labelled, timestamped
  // last-known value for each reference. At demo time the fixture connector is
  // not configured, so those values come back marked STALE and carrying the
  // error — which is exactly the discipline DATA-BACKBONE.md §6 asks for:
  // degrade visibly, never substitute a guess.
  for (const pageId of referencedPages) await store.resolveReferences(operator, pageId);

  // ---- the clock ---------------------------------------------------------
  // Nothing is hand-set to Needs Update. The pages that should be there are
  // Canonical with a review date in the past, and the ordinary freshness sweep
  // is what moves them, writing the same audit events and owner notices it
  // writes in a deployment.
  store.sweepFreshness(operator, { limit: 5000 });

  // ---- archived ----------------------------------------------------------
  // A handful, so the record has material that has left the map without
  // leaving the record. They are chosen from published notes only: archiving a
  // Canonical policy would be a strange thing for a demo to depict.
  let archived = 0;
  for (const page of pages) {
    if (page.type !== 'note' || page.depth < 3 || archived >= 6) continue;
    if (!rng.chance(0.06)) continue;
    store.archivePage(actors.get(page.ownerKey)!, page.id);
    archived += 1;
  }

  // ---- the report --------------------------------------------------------
  const graph = store.recordGraph(operator);
  const byType: Record<string, number> = {};
  const byProvenance: Record<string, number> = {};
  const edgeCounts = Object.fromEntries(GRAPH_EDGE_KINDS.map((k) => [k, 0])) as Record<GraphEdgeKind, number>;
  for (const node of graph.nodes) {
    if (node.kind !== 'page') continue;
    byType[node.type] = (byType[node.type] ?? 0) + 1;
    byProvenance[node.provenance] = (byProvenance[node.provenance] ?? 0) + 1;
  }
  for (const edge of graph.edges) edgeCounts[edge.kind] += 1;
  const statuses: Record<string, number> = {};
  for (const node of graph.nodes) {
    if (node.kind === 'page' && node.status) statuses[node.status] = (statuses[node.status] ?? 0) + 1;
  }
  const collectionOf = new Map(graph.nodes.filter((n) => n.kind === 'page').map((n) => [n.id, n.collectionId]));
  const crossing = graph.edges.filter(
    (e) => e.kind === 'link' && collectionOf.get(e.from) !== collectionOf.get(e.to),
  ).length;

  const report: SeedReport = {
    seed,
    actors: PEOPLE.length,
    collections: COLLECTIONS.map((spec) => ({
      name: spec.name,
      id: collectionIds.get(spec.key)!,
      pages: graph.nodes.filter((n) => n.kind === 'page' && n.collectionId === collectionIds.get(spec.key)).length,
      members: memberCounts.get(spec.key) ?? 0,
    })),
    pages: graph.nodes.filter((n) => n.kind === 'page').length,
    byStatus: statuses,
    byType,
    byProvenance,
    edges: edgeCounts,
    crossCollectionLinks: crossing,
    maxDepth: Math.max(...pages.map((p) => p.depth)),
    sources: SOURCES.length,
    references,
    relations,
    imports,
    archived,
    graph: { collections: graph.collections.length, nodes: graph.nodes.length, edges: graph.edges.length },
    operatorId: operator,
  };
  say(`  links         ${edgeCounts.link} written, ${crossing} of them crossing a collection`);
  say(`  federated     ${SOURCES.length} sources, ${references} reference fields`);
  say(
    `  disagreement  ${relations} asserted relations ` +
      `(${edgeCounts.conflicts_with} conflicts with, ${edgeCounts.supersedes} supersedes)`,
  );
  return report;
}

// A page's intended standing. Weighted by what it is and where it sits: roots
// and branches are the official record and mostly reach Canonical; leaves are
// where working material lives.
function targetStatus(type: DocType, depth: number, rng: Rng): PageStatus {
  // A Note never carries the Canonical mark and never goes through review, so
  // there is exactly one place it can be. Some of them never get published at
  // all, which is decided where the bodies are written.
  if (type === 'note') return 'draft';
  if (depth <= 2) {
    return rng.weighted<PageStatus>([
      ['canonical', 62],
      ['needs_update', 14],
      ['in_review', 12],
      ['draft', 12],
    ]);
  }
  return rng.weighted<PageStatus>([
    ['canonical', 40],
    ['needs_update', 12],
    ['in_review', 16],
    ['draft', 32],
  ]);
}

const DEPTH_FOUR: { suffix: string; type: DocType; purpose: (topic: string) => string }[] = [
  { suffix: 'worked example', type: 'note', purpose: (t) => `a worked example of ${lowerFirst(t)}` },
  { suffix: 'appendix', type: 'note', purpose: (t) => `the supporting detail behind ${lowerFirst(t)}` },
  { suffix: 'review record', type: 'note', purpose: (t) => `what the last review of ${lowerFirst(t)} concluded` },
  { suffix: 'implementation notes', type: 'spec', purpose: (t) => `how ${lowerFirst(t)} is implemented in practice` },
];

const REVISION_NOTES: string[] = [
  'This revision tightens the deadline language after a case where two teams read it differently.',
  'This revision adds the escalation path that was missing when the last incident happened.',
  'This revision removes a paragraph that duplicated the parent page and had already drifted from it.',
  'This revision reflects the rule change flagged by horizon scanning last quarter.',
];

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function bodyFor(page: SeededPage, rng: Rng, byId: Map<string, SeededPage>): string {
  const opening = rng.pick(OPENINGS[page.type]).replace('{purpose}', page.purpose);
  const scope = rng.pick(SCOPE_LINES[page.collectionKey] ?? SCOPE_LINES.compliance!);
  const rules = RULE_LINES[page.collectionKey] ?? RULE_LINES.compliance!;
  const chosen: string[] = [];
  for (let i = 0; i < 3 && chosen.length < rules.length; i += 1) {
    const line = rules[rng.int(0, rules.length - 1)]!;
    if (!chosen.includes(line)) chosen.push(line);
  }
  const parts: string[] = [
    opening,
    '## Scope',
    scope,
    '## What this requires',
    chosen.map((line) => `- ${line}`).join('\n'),
  ];
  if (page.depth >= 3) {
    parts.push('## In practice', rng.pick(PRACTICE_LINES).replace('{title}', page.title));
  }
  if (page.links.length) {
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const id of page.links) {
      if (seen.has(id)) continue;
      seen.add(id);
      const target = byId.get(id);
      lines.push(target ? `- ${target.title}: /pages/${id}` : `- /pages/${id}`);
    }
    parts.push('## Related', lines.join('\n'));
  }
  const owner = PERSON_BY_KEY.get(page.ownerKey);
  if (owner) parts.push(`Owner: ${owner.name}, ${owner.title}.`);
  parts.push(rng.pick(CLOSINGS));
  return parts.join('\n\n');
}

const PRACTICE_LINES: string[] = [
  'In practice, "{title}" is where most of the questions land, so it is written to be read in a hurry and checked in detail afterwards.',
  'The step people most often get wrong here is recording the decision at the time rather than at the end of the week.',
  'Where this differs from how it used to be done, the old way is not wrong so much as no longer evidenced.',
  'If the situation in front of you is not described here, write down what you did and raise it at the next review.',
];

// ---------------------------------------------------------------------------
// The command line

interface Args {
  db: string;
  seed: number;
  force: boolean;
  help: boolean;
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = { db: process.env.CANON_DB ?? 'canon.db', seed: 20260731, force: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force') args.force = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--db') args.db = argv[++i] ?? args.db;
    else if (arg?.startsWith('--db=')) args.db = arg.slice(5);
    else if (arg === '--seed') args.seed = Number(argv[++i] ?? args.seed);
    else if (arg?.startsWith('--seed=')) args.seed = Number(arg.slice(7));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(args.seed)) throw new Error('--seed takes a number');
  return args;
}

const USAGE = `
seed-demo — build a demo corpus in a Veryl Canon record.

  npm run seed:demo -- [--db <path>] [--seed <n>] [--force]

  --db <path>   where to write. Defaults to $CANON_DB, then ./canon.db
  --seed <n>    the PRNG seed. The same seed builds the same corpus. Default 20260731
  --force       build it even though the record already holds something

THIS IS A DEVELOPMENT TOOL, FOR DEMOS AND TESTS. Never run it against a
deployment: it invents people, writes hundreds of pages under their names, and
registers external sources. A record with this corpus in it is a demo record.
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE.trim());
    return;
  }
  console.log(`Veryl Canon demo seeder — a DEVELOPMENT TOOL, never for a deployment.`);
  console.log(`  record        ${args.db}`);
  console.log(`  seed          ${args.seed}`);

  const db = openDb(args.db);
  const existing = recordHasContent(db);
  const populated = existing.collections + existing.pages + existing.actors > 0;
  if (populated && !args.force) {
    console.error(
      `\nRefusing to seed: ${args.db} already holds ${existing.actors} actor(s), ` +
        `${existing.collections} collection(s) and ${existing.pages} page(s).\n` +
        `Point --db somewhere else, delete that file, or pass --force to add the demo corpus anyway.`,
    );
    process.exitCode = 1;
    return;
  }
  if (populated) {
    console.warn(
      `  *** --force: adding a demo corpus to a record that already holds ` +
        `${existing.pages} page(s). This cannot be undone; history is append-only. ***`,
    );
  }

  const store = new CanonStore(db, QUIET);
  const started = Date.now();
  const report = await seedDemo(store, { seed: args.seed });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  const pad = (value: unknown, width = 5): string => String(value).padStart(width);
  console.log(`\nBuilt in ${seconds}s:\n`);
  console.log(`  ${pad(report.actors)} people`);
  console.log(`  ${pad(report.collections.length)} collections`);
  for (const collection of report.collections) {
    console.log(`        ${String(collection.pages).padStart(4)} pages  ${collection.members} members  ${collection.name}`);
  }
  console.log(`  ${pad(report.pages)} pages on the map, ${report.maxDepth} levels deep, ${report.archived} archived off it`);
  console.log(`        status      ${format(report.byStatus)}`);
  console.log(`        type        ${format(report.byType)}`);
  console.log(`        provenance  ${format(report.byProvenance)}`);
  const edgeTotal = Object.values(report.edges).reduce((a, b) => a + b, 0);
  console.log(
    `  ${pad(edgeTotal)} edges: ` +
      `${report.edges.child} child, ${report.edges.link} link ` +
      `(${report.crossCollectionLinks} crossing a collection), ${report.edges.reference} reference, ` +
      `${report.edges.conflicts_with} conflicts with, ${report.edges.supersedes} supersedes`,
  );
  console.log(`  ${pad(report.sources)} sources, ${report.references} reference fields`);
  console.log(`  ${pad(report.relations)} pages asserted to conflict with or supersede another`);
  for (const run of report.imports) {
    console.log(`        import      ${run.source} → ${run.collection}: ${run.imported} imported, ${run.failed} failed`);
  }
  console.log(
    `\n  GET /graph draws ${report.graph.nodes} nodes and ${report.graph.edges} edges ` +
      `across ${report.graph.collections} collections.`,
  );
  console.log(`\nNext:\n  CANON_DEV_AUTH=true CANON_DB=${args.db} npm start`);
  console.log(`  and sign in as Dana Whitfield (${report.operatorId}), who administers every collection.`);
  console.log(
    `\nNote: the federated values were resolved once, by this seeder, against its own\n` +
      `fixture connector. A server started without those fixtures shows each value as the\n` +
      `last known one, marked stale and carrying the error — which is what federation is\n` +
      `supposed to look like when a source cannot be reached.`,
  );
}

function format(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n]) => `${name} ${n}`)
    .join(', ');
}

// Run only when invoked as a program: importing this module (which the tests
// do) must never write to anybody's record as a side effect.
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(`seed-demo failed: ${(err as Error).message}`);
    process.exitCode = 1;
  });
}
