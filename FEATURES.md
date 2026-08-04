# Veryl Canon Feature Breakdown

This document breaks Veryl Canon into concrete features. It draws on two proven products: Confluence for the shape of shared knowledge (spaces, pages, co-editing, search) and Jira for structure (statuses, workflows, approvals, queries). Canon combines both and adds what neither has: agents as governed, first-class collaborators.

Each section lists the features, what they do, and where the inspiration comes from.

---

## 1. The record

How knowledge is organized and held.

### Collections
Top-level containers for a team, department, or domain. A Compliance collection, a Product collection, an HR collection. Each has its own home page, structure, and access rules. *(Confluence: Spaces.)*

### Pages and page trees
The unit of knowledge is a page. Pages nest into trees, so a product plan can hold its specs, and a policy can hold its procedures. Moving a branch moves its children. *(Confluence: pages and the page tree.)*

### Document types
A page declares what kind of record it is: Policy, Spec, Plan, Decision, Runbook, Note. Each type carries its own fields, template, and workflow. A Policy requires an owner, a review date, and an approver. A Note requires nothing. *(Jira: issue types with their own fields and workflows.)*

### Structured fields
Beyond the body text, pages of a given type carry structured fields: owner, status, effective date, review date, applies-to. Fields make the record queryable and let rules attach to data, not prose. *(Jira: custom fields.)*

### Labels
Freeform tags across collections for cross-cutting themes. *(Confluence: labels.)*

## 2. Writing and editing

How people put knowledge in.

### Editor
A clean, rich editor: headings, tables, images, embeds, code blocks, callouts. Built for non-technical staff. No markup knowledge required, though Markdown shortcuts work for those who want them. *(Confluence: the page editor.)*

### Real-time co-editing
Multiple people, and approved agents, edit a page at once with visible cursors and instant sync. *(Confluence: collaborative editing.)*

### Drafts and publishing
Edits accumulate in a draft that only editors see. Publishing makes them the current version. Readers never see half-finished work. *(Confluence: draft and publish.)*

### Templates
Each document type ships with a starting template, and organizations add their own. A new Policy page opens with the right sections and fields already in place. *(Confluence: templates and blueprints.)*

### Version history
Every published version is kept. Compare any two versions, see who changed what, and restore an earlier one. History is never editable. *(Confluence: page history. Jira: the immutable change log.)*

## 3. Canonical status and workflow

What makes Canon a source of record rather than a wiki. This is where Jira's DNA matters most.

### Page status
Every page has a status: Draft, In Review, Canonical, Needs Update, Archived. Status is visible everywhere the page appears, so a reader always knows whether they are looking at the official record. *(Jira: issue status.)*

### Review workflows
Document types define how a page reaches Canonical. A Note may publish directly. A Policy may require review by a named approver or group before it can carry the Canonical mark. Workflows are configurable per type and per collection, with sensible defaults. *(Jira: configurable workflows with transitions and approvals.)*

### Verification and freshness
Canonical pages carry a review date. When it passes, the page flips to Needs Update and the owner is notified. Stale knowledge announces itself instead of quietly rotting. *(No direct Confluence equivalent; this is the "official record" promise made mechanical.)*

### Ownership
Every Canonical page has a named owner, a person or team accountable for keeping it true. Ownership transfers explicitly, never silently. *(Jira: assignee, made durable.)*

### Decision records
A lightweight type for recording decisions: context, options, outcome, who decided, when. Decisions are the knowledge companies lose fastest, so Canon treats them as first-class records.

## 4. Working together

How people and agents collaborate on the record.

### Comments
Inline comments anchored to a passage, and page-level comments for broader discussion. Comments resolve when addressed. *(Confluence: inline and page comments.)*

### Mentions and notifications
Mention a person, a team, or an agent to pull them in. Notifications go where the organization already works: email, Slack, Teams. *(Confluence and Jira: mentions and notification schemes.)*

### Tasks
Assign action items inside a page: "@Dana update the retention table by Friday." Tasks roll up to a personal queue so nothing hides in a page nobody reopens. *(Confluence: action items. Jira: the assignment model.)*

### Watching
Watch a page, a tree, or a whole collection and get notified on changes. Compliance teams watch policies. Agents watch the material they depend on. *(Confluence and Jira: watchers.)*

## 5. Agents in Canon

What no existing product has. Agents are collaborators here, under the rules the organization already set.

### Governed access
Agents connect through their Agent Passport from Veryl Agent Registry. What an agent can read or edit follows the identity, certification, and limits defined there. Canon adds no separate agent permission system; the rules are set once and carried in. *(This is the Veryl promise applied to knowledge.)*

### Attributed contributions
Every agent edit, comment, and page is attributed to the agent by name, marked as agent work, and recorded in history exactly like a person's. Nothing an agent does is anonymous or invisible.

### Agent proposals
Agents contribute through the same workflow people use. An agent that spots a stale figure or a gap drafts a change and submits it for review. A certified agent working within its limits can publish directly where the workflow allows it, the same rule that applies to a trusted person. *(Jira: workflow transitions gated by permission, applied to agents.)*

### Grounded answers
People ask questions in plain language and get answers drawn only from Canonical pages, with citations linking to the source. The answer is only as official as the record behind it, and it says so.

### Freshness by agents
Approved agents help keep the record true: flagging pages that contradict each other, drafting updates when a source system changes, and nudging owners when review dates near. People stay the approvers; agents do the tedious watching.

### Knowledge API
A clean read and write API for approved agents and for apps built in Veryl Studio. A Studio app answering benefits questions draws on the same Canonical policies the HR team maintains, live, with no export step.

## 6. Finding and using knowledge

Knowledge only counts if it can be found.

### Search
Fast full-text search across everything the searcher is allowed to see, ranked with Canonical pages first. Filters for collection, type, status, owner, and label. *(Confluence: search, sharpened by status.)*

### Structured queries
Query the record by its fields: "all Canonical policies owned by Compliance with a review date in the next 60 days." Save queries and pin them to dashboards. *(Jira: JQL, aimed at documents.)*

### Home and dashboards
A personal home surfacing what matters: pages you own that need review, tasks assigned to you, activity on what you watch. Collection dashboards do the same for teams. *(Jira: dashboards. Confluence: space overviews.)*

### Aliases: the record learns your words
A page carries the names people actually use for its subject — "urgent" beside a page that says "expedited", "COB" beside Coordination of benefits. An alias is a field like any other: versioned, attributed, reviewed before it steers anything, and read by search and by grounded answers alike. It exists because no ranking improvement closes a vocabulary gap; a person closes it, once, with their name on the change.

### Gaps: what the record was asked and could not answer
Every refused question is kept — with how often it was asked, never by whom — until an operator closes it: teach a page the asker's word, write the missing page, or record that the record owes no answer. A refusal also shows the asker the nearest pages as places to look, so a dead end becomes one click from recovery. This is the loop that makes Ask improve with use.

## 7. Governance and audit

What regulated buyers need on day one.

### Permissions
Access is set at the collection level and refined per tree or page: who can view, comment, edit, approve. People and agents appear in one permission model. Agent entries are enforced against the Registry, so a lapsed certification means lapsed access, immediately. *(Confluence: space and page permissions. Jira: permission schemes.)*

### Audit log
Every meaningful action is logged: views of restricted material, edits, approvals, permission changes, agent activity. The log is exportable and tamper-evident. *(Jira: audit log, extended to agent actions.)*

### Attestation and export
Prove the state of the record: export any page with its full history, approvals, and audit trail. Show an auditor exactly what the policy said on a given date and who had approved it.

### Retention and archival
Archived pages leave search and answers but stay preserved with history intact, subject to the organization's retention rules.

## 8. Administration and analytics

Keeping the whole record healthy.

### Record health
A dashboard for administrators and collection owners: pages past review, pages without owners, orphaned pages, contradictions flagged by agents. The health of the record, measured, not guessed. *(Confluence analytics, pointed at trust rather than traffic.)*

### Usage insight
What people and agents actually read and ask about, and where searches come up empty. Empty searches are the map of missing knowledge.

### Import
Bring existing material in from Confluence, SharePoint, Notion, and Google Docs, preserving structure where it exists. Imported pages arrive as Drafts; nothing becomes Canonical without going through the workflow.

---

## What ships first

A rough cut into three tiers. The first tier is the smallest product that keeps the core promise: one record, used by people and agents, under rules set once.

**Core.** Collections, pages and trees, document types with basic fields, the editor, drafts and publishing, version history, page status with a simple review workflow, comments and mentions, search, permissions with Registry-enforced agent access, attributed agent contributions, grounded answers, the audit log, and import.

**Next.** Real-time co-editing, templates, structured queries, tasks and watching, agent proposals, freshness and review dates, dashboards, the knowledge API for Studio.

**Later.** Decision records, attestation and export, record health, usage insight, notification integrations, retention controls.

---

*Naming per the brief: Veryl Canon in full on first mention and in headings; Canon once inside product context. If the product name falls back to Veryl Knowledge Base, only the name changes.*
