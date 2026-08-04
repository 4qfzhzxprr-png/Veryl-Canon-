# Benefits administration stub

A small standalone service that stands in for the kind of external record system a regulated design partner actually has. It exists so Canon's **federation** — never copy, resolve when read ([DATA-BACKBONE.md](../DATA-BACKBONE.md) §6) — can be built, tested and demonstrated now, and pointed at a real benefits administrator later by changing one base URL.

It plays a benefits administrator: it owns the deductible, the out-of-pocket maximum, the coinsurance split and the effective date, and it will keep owning them. Canon holds a policy page that *references* those values and the plan id to resolve them with; Canon never stores the numbers, because the moment it does, Canon is asserting a figure it does not own and cannot keep true.

Two properties of the real thing are reproduced deliberately, because they are the two that decide whether federation works at all.

**It answers by key and selector only.** There is no ranking, no free-text query, no way to enumerate the plan catalogue through the lookup face. `GET /search` answers `501`, on purpose — a stub that quietly grew a search endpoint would let Canon be designed against a capability the real system does not have, and "you cannot rank what you cannot enumerate" is precisely the trap §6 names. The page supplies the key; the connector supplies the value.

**It has its own access model, and it enforces it per caller.** Every lookup names the caller, and the answer depends on who that is. This is what lets Canon prove it does not launder permissions: resolve everything through one service account and Canon will cheerfully show a reader a figure they are not entitled to see in the system that owns it. Point Canon's connector at this stub and the claim becomes testable — the same reference, read by two people, resolves for one and is refused for the other, decided here rather than in Canon.

## What it implements

Two faces, in the shape [registry-stub](../registry-stub) uses.

**Lookup** (the whole of Canon's dependency):

| | |
|---|---|
| `GET /lookup?key=…&selector=…` | The value, for the caller named in `X-Asker`. |
| `GET /search` | `501 not_supported`. See above; this is a design statement, not a gap. |
| `GET /health` | Liveness. Unaffected by the injected delay, so a monitor can tell "slow" from "gone". |

Selectors are a fixed vocabulary — `deductible`, `outOfPocketMaximum`, `genericCoinsurance`, `brandCoinsurance`, `effectiveDate` — and anything else is a `404`, never a guess and never a null. An answer carries `{ key, selector, value, unit, asOf, system }`: `value` is all a connector must understand, and the rest is context a resolved reference can carry into a citation.

Refusals, and the order they are applied in:

| Status | Error | Meaning |
|---|---|---|
| `401` | `no_asker` | No `X-Asker`. This system answers no one it cannot name. |
| `403` | `not_entitled` | This caller may not see this plan. Checked **before** existence, so 403s cannot be used to map the catalogue. |
| `404` | `unknown_plan` / `unknown_selector` | Entitled, but there is nothing under that key or field. |
| `400` | `invalid` | The request did not carry a key and a selector. |

**Administration** (what tests and demonstrations drive):

| | |
|---|---|
| `POST /admin/plans` | Seed or replace a plan. |
| `GET /admin/plans` | List seeded plans. |
| `PUT /admin/entitlements/:asker` | Grant a caller a list of plan ids, or `["*"]` for all. Grants replace, they do not merge. |
| `GET /admin/entitlements` | What has been granted to whom. |
| `PUT /admin/behaviour` | The injected failure modes: `{ "delayMs": 400 }` makes it slow, `{ "failStatus": 500 }` makes it fail, `null` recovers. |
| `GET /admin/behaviour` | The current setting. |

The two failure modes exist so a connector's degradation can be exercised honestly rather than asserted. A source that is slow and a source that is broken are different failures with different handling — and neither may ever become an invented value.

Honest liberties of a test double, the same two registry-stub takes: state is in-memory and disposable, and the administrative face is unauthenticated. The lookup face is not.

## Running it

Node 22+, zero runtime dependencies (`node:http`, `node:timers/promises`, `node:test`).

```sh
npm install   # dev dependencies only (TypeScript)
npm test      # build + stub endpoint suite + Canon's HttpConnector run against the stub in-process
npm start     # serve on :3200 (PORT to override)
```

The test build also compiles [`../server/src/httpconnector.ts`](../server/src/httpconnector.ts) — Canon's real connector — and runs it against this stub in-process: a successful resolve, the asker's identity reaching the source and being enforced there, a `403` handled as a real answer, and timeout, `5xx`, unreachable and unparseable all handled as *no* answer with no value produced.

## A demonstration by hand

```sh
npm start &

# Seed a plan and decide who may see it.
curl -s :3200/admin/plans -d '{"planId":"plan-gold-2026","name":"Gold PPO 2026","deductible":1500,
  "outOfPocketMaximum":6000,"genericCoinsurance":10,"brandCoinsurance":30,"effectiveDate":"2026-01-01"}'
curl -s :3200/admin/entitlements/person-jo -X PUT -d '{"plans":["plan-gold-2026"]}'

curl -s ':3200/lookup?key=plan-gold-2026&selector=deductible' -H 'X-Asker: person-jo'
# {"key":"plan-gold-2026","selector":"deductible","value":1500,"unit":"USD","asOf":"…","system":"benefits-admin"}

curl -s ':3200/lookup?key=plan-gold-2026&selector=deductible' -H 'X-Asker: person-ada'
# 403 not_entitled — the source decides, not Canon

curl -s ':3200/lookup?key=plan-gold-2026&selector=deductible'
# 401 no_asker — nothing is answered anonymously

# Break it, watch the connector degrade rather than guess, then recover.
curl -s :3200/admin/behaviour -X PUT -d '{"failStatus":500}'
curl -s :3200/admin/behaviour -X PUT -d '{"delayMs":0,"failStatus":null}'
```

## Wiring into Canon

Canon reaches this stub through [`server/src/httpconnector.ts`](../server/src/httpconnector.ts), the real HTTP connector, which implements the seam from §6:

```
resolve(source, request: { selector, key, asker }) -> { value, resolvedAt }
```

It issues `GET {baseUrl}/lookup?key=…&selector=…` with the asking actor in `X-Asker`, and every failure throws a typed `ConnectorError` carrying `kind`: `refused` (403/404 — the source gave a real answer about this reference; do not retry) or `unanswered` (timeout, 5xx, unreachable, unparseable — no answer was obtained, so the last resolved value, labelled and timestamped, is the honest thing to show). It never invents, defaults or substitutes a value; there is no branch in the file that returns one it did not parse out of the source's own answer.

> The `POST /sources`, `GET /sources` and `GET /pages/:id/references` surface below is the API named in §6 and lands with Canon's federation core (`server/src/sources.ts`, `connectors.ts`, `references.ts`). The connector and this stub are what those routes stand on.

### A worked example

Canon on `:3000` with the stub on `:3200`.

**1. Seed the source system.** Jo is entitled to the standard plan; Ada is not.

```sh
curl -s :3200/admin/plans -d '{"planId":"plan-gold-2026","name":"Gold PPO 2026","deductible":1500,
  "outOfPocketMaximum":6000,"genericCoinsurance":10,"brandCoinsurance":30,"effectiveDate":"2026-01-01"}'
curl -s :3200/admin/entitlements/person-jo -X PUT -d '{"plans":["plan-gold-2026"]}'
```

**2. Register the source in Canon.** A source is a governed object, like an agent: it is registered, owned, and limited to the collections it may be referenced from.

```sh
curl -s :3000/sources -H 'X-Actor-Id: person-admin' -d '{
  "name": "Benefits Admin",
  "kind": "benefits-admin",
  "baseUrl": "http://127.0.0.1:3200",
  "authMode": "per_asker",
  "freshnessWindowMs": 86400000,
  "collections": ["col-benefits"]
}'
# -> { "id": "src-benefits", … }
```

`authMode: "per_asker"` is the important line. It means every resolution carries the reader's own identity to the benefits administrator, which is what the stub then enforces. The alternative, `"service"`, resolves everything as the deployment's configured service identity (`CANON_SOURCE_SERVICE_IDENTITY`) — and that is a decision to publish the value to everyone who can view the collection, which the page says in those words rather than burying in configuration.

`freshnessWindowMs` is set from how fast this field actually changes and what the compliance owner will accept. A deductible moves once a year, so a day is generous and honest; a claim status would not get a day. There is deliberately no global default.

**3. Create the page and point a field at the source.** The page carries the plan id — the key the source is asked with — and the reference field says what to ask for.

```sh
curl -s :3000/pages -H 'X-Actor-Id: person-jo' -d '{
  "collectionId": "col-benefits", "type": "policy", "title": "Benefits Overview"
}'
# -> { "id": "page-benefits", … }

curl -s :3000/pages/page-benefits/draft -X PUT -H 'X-Actor-Id: person-jo' -d '{
  "title": "Benefits Overview",
  "body": "Members meet an annual deductible before coinsurance applies.",
  "fields": {
    "ownerId": "person-jo",
    "references": {
      "deductible": { "sourceId": "src-benefits", "selector": "deductible", "key": "plan-gold-2026" }
    }
  }
}'
curl -s :3000/pages/page-benefits/publish -X POST -H 'X-Actor-Id: person-jo' -d '{"note":"Federated deductible"}'
```

**4. Resolve it.** References travel inside the page payload the UI already fetches; `GET /pages/:id/references` resolves them on their own.

```sh
curl -s :3000/pages/page-benefits/references -H 'X-Actor-Id: person-jo'
# { "deductible": { "value": 1500, "resolvedAt": "2026-07-31T09:14:02.113Z",
#                   "fromCache": false, "stale": false, "sourceName": "Benefits Admin" } }
```

And the point of the whole arrangement, in one command:

```sh
curl -s :3000/pages/page-benefits/references -H 'X-Actor-Id: person-ada'
# { "deductible": { "stale": false, "sourceName": "Benefits Admin",
#                   "error": "forbidden" } }   # no value — Ada is not entitled in the source
```

Same page, same reference, same Canon. The benefits administrator refused Ada, so Canon has nothing to show her, and shows nothing. Stop the stub (or `PUT /admin/behaviour {"failStatus":500}`) and the answer changes character: the last resolved value comes back with its timestamp and, past the freshness window, marked stale — never presented as current, and never replaced by a guess.

An answer composed over this page cites both: *the deductible is $1,500, per Benefits Overview version 1, resolved from Benefits Admin at 09:14 today.* The page is cited for the rule, the source for the number, and the reader can check both.
