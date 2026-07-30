# Veryl Canon

**Status: Alpha** — in alpha with a small group of design partners.

The trusted source of company knowledge, built by people and agents together, so what agents act on is the same information teams write and rely on.

*This is the official description from [Veryl.ai](https://veryl.ai). Use it verbatim wherever Canon is introduced cold.*

## What Canon is

Veryl Canon is where a company keeps the knowledge it runs on: product plans, company docs, policies, and specs. People and approved agents work on the same material and keep it current. What agents act on is the same information teams write and rely on. One trusted source, used by both.

The name is deliberate. Canon is the official record, the material everyone treats as authoritative. Not a place to store notes, but the source of record the whole organization works from.

## The problem it solves

Most companies keep two versions of what they know. There is the knowledge people use: docs, wikis, plans, and policies spread across tools, some current and some stale. And there is whatever slice of that knowledge gets copied, exported, or pasted into AI systems so agents can use it. The two drift apart. Agents act on outdated or partial information, and nobody is sure which version is real.

Canon removes the gap. There is one record. When a person updates a policy or a plan, that is what agents see. When an approved agent adds or revises material, that is what people see. Nothing is exported, mirrored, or left behind.

## How it works

- **One shared record.** Plans, docs, policies, and specs live in one place. Teams write and maintain them there, and agents draw on them there.
- **People and agents as co-authors.** Approved agents do not just read the record. They help keep it current, working on the same material under the same rules as everyone else.
- **Governed by the rules the organization already set.** Agent access to Canon follows the identity, certification, and limits defined in Veryl Agent Registry. An agent can only read or contribute what it is approved to.
- **Built for non-technical people.** Staff in any role can read, write, and rely on Canon without engineering help. Using it should feel like ordinary work, with the safety handled underneath.

## Who it is for

Organizations that want to put advanced AI to work across the whole company, not just engineering. That includes regulated fields such as healthcare, pharmacy benefits, and financial services, where it matters that agents act only on approved, current information and that the company can show where that information came from.

## How Canon fits the Veryl suite

Veryl makes advanced AI safe for any organization to put to work. Set the rules for how AI is used once, and everyone in the company can use it, without added friction or risk. Each product carries that promise:

- **Veryl Agent Registry** is where the rules are set. Every agent gets a verified identity, earns certification before it can act, and works inside secure spaces with clear limits.
- **Veryl Canon** is the company's shared record. Non-technical staff and agents draw from and add to the same knowledge, safely, with no gap between what people know and what agents can use.
- **Veryl Studio** is where the power reaches everyone. Anyone can build and launch AI apps on company data, and the rules set in the Registry keep every app inside safe limits.

Rules are set in one place and carried everywhere, so people can do powerful things safely without being able to do harmful ones.

Within that suite, Canon is the backbone for data storage and organization. Registry and Studio keep no copies of company knowledge; both work against Canon's record, live, under the rules carried in from the Registry. See [DATA-BACKBONE.md](DATA-BACKBONE.md) for what that means in practice.

## Going deeper

See [FEATURES.md](FEATURES.md) for the full feature breakdown: how the record is organized, how pages become canonical, how agents contribute, and what ships first.

See [CORE-PLAN.md](CORE-PLAN.md) for the Core product plan: what the first version must prove, its scope, feature requirements, build order, and success measures.

See [DATA-BACKBONE.md](DATA-BACKBONE.md) for Canon's role as the suite's data backbone: what it stores, how the record is organized, and the contracts Veryl Agent Registry and Veryl Studio depend on.

See [server/](server/) for the code: the running Canon server, starting with the M1 foundation from the Core plan.

## Naming

Use the full name, Veryl Canon, on first mention, in headings, and anywhere the product shows up cold. Once the reader is clearly inside the product's context, the short form Canon is fine.

The name is intentional but under review. Canon signals the trusted, official source of record. If the product turns out to be more of an open, everyday workspace than an official record, the fallback name is Veryl Knowledge Base. That is a one-word change, and nothing else about the product needs to change with it.
