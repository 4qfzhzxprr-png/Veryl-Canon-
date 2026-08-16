import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router-dom";
import { Button } from "@/components/Button";
import { SelectField } from "@/components/Field";
import { Skeleton } from "@/components/Skeleton";
import { StatusTag } from "@/components/StatusTag";
import { api } from "@/lib/api";
import { formatAgo } from "@/lib/format";
import { keys } from "@/lib/queryKeys";
import { useCanonMutation } from "@/lib/useCanonMutation";
import type { Answer, Citation, CitationField } from "@/types/api";

/**
 * Ask the record.
 *
 * **It does not stream, and this client does not pretend it does.** The plan
 * for this migration budgeted a streaming primitive; `POST /ask` is one request
 * and one JSON answer, so there is none. Faking incremental text over a
 * response that arrived whole would be a progress animation dressed as
 * generation — theatre, on the one screen whose whole argument is that it does
 * not make things up.
 *
 * Three properties this screen exists to preserve, all of them about honesty:
 *
 *   * **only Canonical pages are cited**, and the screen says so before the
 *     question is asked rather than after;
 *   * **a refusal is an answer.** When the record is silent Canon says so
 *     instead of guessing, and the refusal offers what came closest — pointers,
 *     not prose;
 *   * **every claim carries its citation**, and a cited page's standing travels
 *     with it, because a reader deciding whether to act on a quotation needs to
 *     know whether the page behind it is still current.
 */
export function Ask() {
  const { id: scoped } = useParams();
  const [question, setQuestion] = useState("");
  const [collectionId, setCollectionId] = useState(scoped ?? "");

  const collections = useQuery({ queryKey: keys.collections.all, queryFn: api.collections });

  const ask = useCanonMutation({
    run: (asked: string) => api.ask(asked, collectionId || undefined),
    // A refusal records a gap, so the gaps screen has to hear about it.
    invalidates: [["gaps"]],
    announce: (result) =>
      result.refused
        ? "The record has no answer to that."
        : `Answered, with ${result.citations.length} citation${result.citations.length === 1 ? "" : "s"}.`,
  });

  const scopedName = collections.data?.find((c) => c.id === collectionId)?.name;

  return (
    <div className="mx-auto max-w-[820px] px-md py-lg sm:px-lg">
      <h1 className="mb-1 font-sans text-title font-bold">Ask the record</h1>
      <p className="mb-lg text-ui text-muted">
        A plain-language question, answered only from Canonical pages you are permitted to
        see, with a citation for every claim. When the record is silent, Canon says so
        instead of guessing.
      </p>

      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (question.trim()) ask.submit(question.trim());
        }}
      >
        <label htmlFor="question" className="sr-only">
          Your question
        </label>
        <textarea
          id="question"
          rows={2}
          maxLength={500}
          value={question}
          onChange={(event) => setQuestion(event.currentTarget.value)}
          placeholder="e.g. How much parental leave do we give?"
          className="min-h-[76px] w-full rounded-md border border-border bg-surface p-3 text-[16px] text-text placeholder:text-muted focus:border-action focus:outline-none focus:ring-2 focus:ring-action/40"
        />

        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-[240px] flex-1">
            <SelectField
              label="Answer from"
              value={collectionId}
              onChange={(event) => setCollectionId(event.currentTarget.value)}
            >
              <option value="">Every collection I can see</option>
              {collections.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </SelectField>
          </div>
          <Button
            type="submit"
            variant="primary"
            busy={ask.busy}
            busyLabel="Asking…"
            disabled={!question.trim()}
          >
            Ask
          </Button>
        </div>

        {/* Said BEFORE the question is asked. What can be cited is the whole
            basis for trusting the answer, and a reader who learns it afterwards
            has already decided whether to believe it. */}
        <p className="text-meta text-muted">
          Grounded in Canonical pages only
          {scopedName ? (
            <>
              , within <strong className="text-text">{scopedName}</strong>
            </>
          ) : null}{" "}
          — including any now Needs Update, which are still the record&rsquo;s own answer and
          are marked as such wherever they are cited. Drafts, Notes, and pages in review are
          never used.
        </p>
        {/* Stated honestly to the person it most concerns: the one typing. */}
        <p className="text-meta text-muted">
          Questions are kept in the audit log, readable by you and by this record&rsquo;s
          operators.
        </p>
      </form>

      <div className="mt-lg" aria-live="polite">
        {ask.busy ? (
          <Skeleton variant="block" label="Asking the record" />
        ) : ask.error ? (
          <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-ui text-danger">
            {ask.error}
          </p>
        ) : ask.raw.data ? (
          <Result answer={ask.raw.data} scoped={scopedName ?? null} />
        ) : null}
      </div>
    </div>
  );
}

function Result({ answer, scoped }: { answer: Answer; scoped: string | null }) {
  if (answer.refused) return <Refusal answer={answer} scoped={scoped} />;

  return (
    <article>
      {/* The prose, as plain text. It is generated from the record's own
          passages, and rendering it as markup would let a page's contents
          decide what the answer looks like. */}
      <p className="whitespace-pre-wrap text-ui leading-relaxed text-text">{answer.answer}</p>

      <h2 className="mt-lg text-ui font-semibold">
        {answer.citations.length === 1 ? "The page this came from" : "The pages this came from"}
      </h2>
      <ul className="mt-2 flex flex-col gap-2">
        {answer.citations.map((citation) => (
          <li key={`${citation.pageId}-${citation.version}`}>
            <CitationCard citation={citation} />
          </li>
        ))}
      </ul>
    </article>
  );
}

/**
 * A refusal is an answer, and it is the feature.
 *
 * It is drawn as information rather than as an error: nothing went wrong, the
 * record simply does not say. What it offers instead is pointers — the pages
 * that came closest — never a paraphrase, because a paraphrase of a page that
 * did not answer the question is exactly the guess this screen refuses to make.
 */
function Refusal({ answer, scoped }: { answer: Answer; scoped: string | null }) {
  return (
    <section className="rounded-md border border-border p-md">
      <h2 className="text-ui font-semibold text-text">The record does not answer that</h2>
      <p className="mt-1 text-ui text-muted">
        Nothing Canonical that you can read covers this question. Canon has recorded it as a
        gap — that is how the missing page gets written.
      </p>
      {/* PRECISE ON PURPOSE, because the obvious sentence is misleading. A gap
          from an unscoped question belongs to no collection, and a steward's
          Gaps screen is narrowed to the collections they steward — so the
          person who just asked would go to Gaps, find nothing, and reasonably
          conclude the promise above was untrue. It was recorded; they just
          cannot see it there. Scoping the question is what puts it in front of
          somebody who can act on it. */}
      {scoped ? (
        <p className="mt-1 text-meta text-muted">
          It will appear under <a className="text-action hover:underline" href="#/gaps">Gaps</a>{" "}
          for whoever stewards {scoped}.
        </p>
      ) : (
        <p className="mt-1 text-meta text-muted">
          You asked across every collection, so this gap belongs to none of them and will not
          appear under Gaps for anybody. Ask again inside one collection to put it in front of
          the people who steward that material.
        </p>
      )}

      {answer.nearest?.length ? (
        <>
          <h3 className="mt-md text-meta font-medium text-muted">What came closest</h3>
          <ul className="mt-1 flex flex-col gap-1">
            {answer.nearest.map((page) => (
              <li key={page.pageId} className="flex flex-wrap items-center gap-2">
                <a className="text-ui text-action hover:underline" href={`#/pages/${page.pageId}`}>
                  {page.title}
                </a>
                {page.status ? <StatusTag status={page.status} /> : null}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-meta text-muted">
            These are pointers, not an answer. Canon has not read them as covering your
            question.
          </p>
        </>
      ) : null}
    </section>
  );
}

function CitationCard({ citation }: { citation: Citation }) {
  return (
    <article className="card p-md">
      <div className="flex flex-wrap items-center gap-2">
        <a
          className="min-w-0 flex-1 truncate text-ui font-medium text-action hover:underline"
          href={`#/pages/${citation.pageId}`}
        >
          {citation.title}
        </a>
        <span className="shrink-0 text-meta text-muted">version {citation.version}</span>
        {/* Rendered only when the server said. Absent means "this response
            cannot say", not "canonical" — defaulting it would assert the most
            trust-bearing thing the client knows about a page the record never
            described. */}
        {citation.status ? <StatusTag status={citation.status} /> : null}
      </div>

      <blockquote className="mt-2 whitespace-pre-wrap border-l-2 border-border pl-3 text-meta text-muted">
        {citation.snippet}
      </blockquote>

      {citation.fields?.length ? <Fields fields={citation.fields} /> : null}

      <p className="mt-2 text-meta">
        <a
          className="text-action hover:underline"
          href={`#/pages/${citation.pageId}/versions/${citation.version}`}
        >
          Read the exact version this quotes
        </a>
      </p>
    </article>
  );
}

/**
 * Federated fields on a cited page, resolved when the answer was built.
 *
 * A stale or failed field is said so IN PLACE rather than being hidden. A
 * number quoted from a system of record that could not be reached, shown
 * without a word, is the single most dangerous thing this screen could draw.
 */
function Fields({ fields }: { fields: CitationField[] }) {
  return (
    <dl className="mt-2 flex flex-col gap-1 rounded-md bg-surface-2 p-2 text-meta">
      {fields.map((field) => (
        <div key={field.label} className="flex flex-wrap items-baseline gap-2">
          <dt className="text-muted">{field.label}</dt>
          <dd className="text-text">
            {field.error ? (
              <span className="text-danger">could not be read — {field.error}</span>
            ) : (
              String(field.value ?? "—")
            )}
          </dd>
          <span className="text-muted">
            from {field.sourceName}
            {field.resolvedAt ? `, ${formatAgo(field.resolvedAt) ?? ""}` : ""}
          </span>
          {field.stale ? (
            <span className="rounded-sm bg-warn/12 px-1.5 py-0.5 text-warn">
              older than this source allows
            </span>
          ) : null}
        </div>
      ))}
    </dl>
  );
}
