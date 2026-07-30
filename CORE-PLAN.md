# Veryl Canon Core Product Plan

This plan covers the Core tier from [FEATURES.md](FEATURES.md): the smallest Canon that is still Canon. One record, used by people and agents, under rules set once.

It defines what Core must prove, who it serves first, what is in and out of scope, the requirements for each feature, the build order, and how we will know it worked.

---

## 1. What Core must prove

Core is not a smaller wiki. It exists to prove three claims that no existing product can make together:

1. **One record.** People and approved agents read and write the same knowledge, live, with no export or sync step between "what people know" and "what agents use."
2. **Rules set once, carried in.** Agent access to Canon is enforced entirely through Veryl Agent Registry. Canon ships no separate agent permission system, and a lapsed certification means lapsed access immediately.
3. **Official means something.** A page marked Canonical has passed the review its type requires, has a named owner, and shows its status everywhere it appears. Readers and agents can tell the record from a rough note.

If Core proves these three things for one design partner in a regulated field, it has succeeded. Everything else is deferred.

## 2. First users

Core targets one to three design partner organizations in regulated fields such as healthcare, pharmacy benefits, or financial services. Within each organization, four roles:

- **Contributor.** Any staff member who reads, writes, and comments. Non-technical by default. The product must feel like ordinary document work.
- **Owner and approver.** Accountable for specific pages. Reviews drafts, grants the Canonical mark, answers for the record's truth.
- **Administrator.** Sets up collections, permissions, and document types. Connects Canon to the Registry. Answers to auditors.
- **Approved agent.** Connects through its Agent Passport. Reads what it is permitted to read, contributes with attribution, and answers questions grounded in the record.

## 3. Scope

### In scope for Core

Collections, pages and trees, document types with basic fields, the editor, drafts and publishing, version history, page status, a simple review workflow, comments and mentions, search, Registry-enforced permissions, attributed agent contributions, grounded answers, the audit log, and import.

### Out of scope for Core

Real-time co-editing, custom templates, structured queries, tasks and watching, agent proposals, automated freshness and review dates, dashboards, the knowledge API for Studio, decision records, attestation and export, record health, usage insight, notification integrations beyond email, and retention controls. Each is planned for a later tier and nothing in Core may foreclose it.

Two deferrals need explicit workarounds in Core:

- Without co-editing, Core prevents conflicts with a simple page lock: one editor at a time per draft, with a visible "being edited by" indicator.
- Without agent proposals, agents in Core write only where the workflow allows direct publishing, and are otherwise read-only. The full propose-and-review loop for agents lands in the Next tier.

## 4. Feature requirements

Grouped into five epics, in build order.

### Epic A: The record

The foundation. Everything else hangs off it.

- **Collections.** Create, name, and describe collections. Each has a home page and a member list. Collection-level access: view, comment, edit, approve, admin.
- **Pages and trees.** Create, edit, move, and archive pages. Pages nest without depth limit. Moving a branch moves its children. Every page has a stable link that survives moves.
- **Document types.** Core ships four built-in types: Policy, Spec, Plan, Note. Types are fixed in Core; custom types come later. Policy and Spec require an owner and an approver. Plan requires an owner. Note requires nothing.
- **Basic fields.** Owner, status, and type on every page. Effective date on Policy. Fields render in a consistent header block on the page and are stored as data, not prose.

### Epic B: Writing and publishing

The daily loop for contributors.

- **Editor.** Headings, bold and italics, lists, tables, links, images, code blocks, and callouts. Markdown shortcuts supported, never required. Pasted content from Word and Google Docs keeps its basic structure.
- **Drafts and publishing.** Editing a published page creates a draft visible only to editors. Publishing replaces the current version in one step. A page lock keeps drafts to one editor at a time.
- **Version history.** Every published version kept, with author, timestamp, and an optional note. Side-by-side comparison of any two versions. Restore creates a new version; history is never rewritten.

### Epic C: Status and review

What makes the record official.

- **Page status.** Draft, In Review, Canonical, and Archived in Core. Needs Update joins when automated freshness lands in the Next tier. Status shows on the page, in the tree, and in search results.
- **Simple review workflow.** One workflow, driven by type. Note publishes directly and never carries the Canonical mark. Plan, Spec, and Policy move Draft to In Review when submitted, and In Review to Canonical when the named approver accepts. The approver can send a draft back with a comment. No custom workflow builder in Core.
- **Comments and mentions.** Inline comments anchored to a passage and page-level comments. Comments resolve. Mentioning a person notifies them by email. Review requests and approvals also notify by email.

### Epic D: Agents and answers

The differentiator. Ships only after Epics A through C are stable.

- **Registry-enforced permissions.** Agents authenticate to Canon with their Agent Passport. Canon checks identity and certification against the Registry on every session and enforces the agent's permitted collections and actions. Revocation in the Registry takes effect in Canon within one minute. Canon stores no agent credentials of its own.
- **Attributed agent contributions.** Where an agent is permitted to write, its edits, comments, and pages are attributed to the agent by name, visibly marked as agent work, and recorded in history and the audit log exactly like a person's.
- **Grounded answers.** A question box available on every page and on the home screen. Answers draw only from Canonical pages the asker is permitted to see, cite their sources with links, and say plainly when the record holds no answer. No answer is ever drawn from Drafts or Notes.

### Epic E: Trust and arrival

What administrators and auditors need, and how content gets in.

- **Audit log.** Records page views on restricted collections, edits, publications, status changes, approvals, permission changes, and all agent activity. Filterable by actor, action, and date. Exportable as CSV. Append-only.
- **Import.** Importers for Confluence and Google Docs in Core, preserving page structure and trees where they exist. Everything arrives as Draft Notes or Draft pages of a chosen type. Nothing becomes Canonical without passing through review. SharePoint and Notion importers come later.

## 5. Build order and milestones

Four milestones, sequenced so each one is usable by the design partner as it lands. No calendar dates in this document; sequencing and exit criteria only.

**M1: A record exists.** Epics A and B. A team can organize collections, write pages of the four types, publish, and see history. Exit: the design partner's pilot team keeps one real document set in Canon for its daily work.

**M2: The record is official.** Epic C. Status, review, comments, and email notifications. Exit: the pilot team takes one real policy or spec from Draft to Canonical through review, and a reader can tell official from rough at a glance.

**M3: Agents join.** Epic D. Registry integration, attributed agent activity, grounded answers. Exit: an approved agent answers real questions from the Canonical record with citations, and revoking it in the Registry cuts its access within a minute, demonstrated live.

**M4: Ready for the auditor.** Epic E, plus hardening. Audit log, import, and a security review. Exit: the design partner's existing material is imported and reviewed into the record, and an administrator can answer "who did what, when" from the audit log alone.

The design-partner phase is called the alpha, matching the public status on Veryl.ai. The alpha begins at M2 and widens at each milestone. General availability is a decision taken after M4, not a milestone in this plan.

## 6. Success measures

Measured with the design partners during the alpha:

- **Adoption.** Weekly active contributors as a share of the pilot team, and pages published per week. The record is alive, not a launch-day dump.
- **Officialness.** Share of reads that land on Canonical pages, and median time from Draft to Canonical. The mark is being earned and used.
- **One record.** Share of grounded answers with at least one citation, and zero answers drawn from non-Canonical material, verified by sampling.
- **Rules carried in.** Zero agent actions outside Registry-granted permissions, verified by audit log review, and revocation-to-lockout time under one minute.
- **Trust.** The design partner's compliance lead signs off that the audit log answers their questions. A qualitative gate, and the one that matters most for the segment.

## 7. Risks

- **The Registry dependency cuts both ways.** Core's differentiator depends on Registry integration being ready and stable. Mitigation: agree the Passport authentication and certification-check contract with the Registry team before M1 ends, and build Epic D against a stub until the live service is ready.
- **Grounded answers erode trust if they are ever wrong.** One confident wrong answer costs more than many right ones earn. Mitigation: citations on every answer, refusal when the record is silent, no generation from non-Canonical pages, and design partner review of sampled answers before the feature is enabled by default.
- **Import quality decides first impressions.** If a partner's Confluence import arrives mangled, the record starts life untrusted. Mitigation: import the design partner's real corpus during M4 development, not after, and treat fidelity gaps as bugs.
- **Review friction could stall adoption.** If reaching Canonical feels like bureaucracy, teams will live in Notes. Mitigation: one approver, one click, email deep links straight into review, and Notes deliberately excluded from grounded answers so official status carries a visible reward.
- **Scope creep from the Next tier.** Co-editing and agent proposals will be requested early. Mitigation: this plan names the workarounds (page lock, read-mostly agents) and the tier where each request lands.

## 8. Open questions

- Does the review workflow need a two-approver option for Policy in regulated partners, or does one named approver satisfy their controls? Resolve with the first design partner before M2.
- Do grounded answers ship enabled by default at M3, or per-collection opt-in? Leaning opt-in for regulated partners.
- Is the one-minute revocation window acceptable to compliance teams, or is session-level immediate cutoff required? Resolve with the Registry team during the contract discussion.
- Which of Confluence or Google Docs import matters more to the first partner? Build that one first within M4.
