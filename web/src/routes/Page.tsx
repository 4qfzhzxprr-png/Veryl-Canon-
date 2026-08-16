import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router-dom";
import { Async } from "@/components/Async";
import { Button } from "@/components/Button";
import { TextArea } from "@/components/Field";
import { Markdown } from "@/components/Markdown";
import { Skeleton } from "@/components/Skeleton";
import { StatusTag } from "@/components/StatusTag";
import { api } from "@/lib/api";
import { formatAgo, formatDate, formatDateTime, TYPE_LABELS } from "@/lib/format";
import { keys } from "@/lib/queryKeys";
import { useCanonMutation } from "@/lib/useCanonMutation";
import type { Ability, Comment, PageDetail } from "@/types/api";

/**
 * One page of the record.
 *
 * **Six independent queries, not one.** The original client awaited everything
 * before rendering anything, so a slow relations lookup held the page's own
 * text off the screen — the part the reader came for. Here each panel is its
 * own query and its own `<Async>`, so the text arrives as soon as the text
 * arrives.
 *
 * Nothing on this screen computes a permission. Every control the server would
 * refuse is rendered disabled with the server's own sentence beside it, which
 * is the treatment that came out of USER-TESTING T4.4: a contributor pressed a
 * fully-enabled button, got a three-second toast in the far corner, and could
 * not tell whether anything had happened.
 */
export function Page() {
  const { id = "" } = useParams();
  const page = useQuery({ queryKey: keys.pages.one(id), queryFn: () => api.page(id) });

  return (
    <div className="mx-auto max-w-[820px] px-md py-lg sm:px-lg">
      <Async
        query={page}
        loadingLabel="Loading this page"
        skeleton={
          <div className="flex flex-col gap-3" aria-hidden>
            <Skeleton variant="row" label="Loading the title" />
            <Skeleton variant="block" label="Loading the text" />
          </div>
        }
      >
        {(detail) => <Detail page={detail} />}
      </Async>

      {/* Outside the page's own query on purpose: comments arriving late must
          not hold back the text, and comments failing must not blank it. */}
      <Comments pageId={id} />
    </div>
  );
}

function Detail({ page }: { page: PageDetail }) {
  return (
    <article>
      <p className="mb-2 text-meta">
        <a className="text-action hover:underline" href={`#/collections/${page.collectionId}`}>
          ← The collection this is in
        </a>
      </p>

      <div className="flex flex-wrap items-start gap-2">
        <h1 className="min-w-0 flex-1 font-sans text-title font-bold">{page.title}</h1>
        <StatusTag status={page.pageStanding ?? page.status} />
      </div>

      <p className="mt-1 text-meta text-muted">
        {TYPE_LABELS[page.type] ?? page.type}
        {page.currentVersion ? ` · version ${page.currentVersion}` : " · never published"}
      </p>

      <Standing page={page} />

      <div className="mt-lg">
        {page.current ? (
          <Markdown body={page.current.body} />
        ) : (
          // Not an error: a page can exist with no published version. Saying so
          // is better than an empty area that reads as a failed load.
          <p className="rounded-md bg-surface-2 px-3 py-2 text-ui text-muted">
            Nothing has been published here yet. There may be a draft.
          </p>
        )}
      </div>

      <nav className="mt-lg flex flex-wrap gap-2" aria-label="This page">
        <Offer ability={page.abilities.edit} href={`#/pages/${page.id}/edit`}>
          Edit
        </Offer>
        <a
          className="inline-flex min-h-[44px] items-center rounded-md border border-border px-3 text-ui hover:bg-surface-2"
          href={`#/pages/${page.id}/history`}
        >
          History
        </a>
      </nav>
    </article>
  );
}

/**
 * What the record is asserting about this page, and when it began to be true.
 *
 * The effective date and its basis are the pair an auditor asks about, and the
 * basis is the half nobody can reconstruct a year later — so a page effective
 * before it was written and with no stated reason says so here, in those words,
 * rather than leaving the reader to notice two dates and do the subtraction.
 */
function Standing({ page }: { page: PageDetail }) {
  const effective = page.effectiveDate;
  const written = page.current?.createdAt ?? page.createdAt;
  const backdated =
    effective && written ? new Date(effective) < new Date(written.slice(0, 10)) : false;

  return (
    <dl className="mt-md grid grid-cols-2 gap-x-4 gap-y-2 rounded-md bg-surface-2 p-3 text-meta sm:grid-cols-3">
      <Fact term="In force from" value={formatDate(effective, "not stated")} />
      <Fact term="Next review" value={formatDate(page.reviewDate, "none set")} />
      <Fact term="Last published" value={page.current ? formatDateTime(page.current.createdAt) : "never"} />
      {backdated ? (
        <div className="col-span-full">
          <dt className="text-muted">Backdated</dt>
          <dd className={page.effectiveDateBasis ? "text-text" : "text-warn"}>
            {page.effectiveDateBasis ??
              "This says it applied before it was written down, and no reason is recorded."}
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

function Fact({ term, value }: { term: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted">{term}</dt>
      <dd className="break-words text-text">{value}</dd>
    </div>
  );
}

/**
 * A control the server has already ruled on.
 *
 * Present and explained when refused, rather than absent. A control that
 * vanishes teaches nobody why; one that is there and greyed, carrying the
 * server's sentence, tells the reader what they would need — usually a role
 * somebody else can grant them.
 */
function Offer({
  ability,
  href,
  children,
}: {
  ability: Ability;
  href: string;
  children: React.ReactNode;
}) {
  if (ability.can) {
    return (
      <a
        className="inline-flex min-h-[44px] items-center rounded-md border border-border px-3 text-ui hover:bg-surface-2"
        href={href}
      >
        {children}
      </a>
    );
  }
  return (
    <span className="inline-flex flex-col gap-1">
      <span
        aria-disabled="true"
        className="inline-flex min-h-[44px] cursor-not-allowed items-center rounded-md border border-border px-3 text-ui text-muted opacity-60"
      >
        {children}
      </span>
      {ability.why ? <span className="text-meta text-muted">{ability.why}</span> : null}
    </span>
  );
}

function Comments({ pageId }: { pageId: string }) {
  const query = useQuery({
    queryKey: keys.pages.comments(pageId),
    queryFn: () => api.comments(pageId),
  });
  const [draft, setDraft] = useState("");

  const add = useCanonMutation({
    run: (body: string) => api.addComment(pageId, body),
    invalidates: [keys.pages.comments(pageId)],
    announce: () => "Comment added.",
    onDone: () => setDraft(""),
  });

  return (
    <section className="mt-2xl" aria-labelledby="comments">
      <h2 id="comments" className="text-ui font-semibold">
        Comments
      </h2>

      <Async
        query={query}
        loadingLabel="Loading the comments on this page"
        skeleton={<Skeleton variant="line" label="Loading the comments" className="mt-2" />}
        isEmpty={(rows) => rows.length === 0}
        empty={<p className="mt-2 text-ui text-muted">No comments yet.</p>}
      >
        {(rows) => (
          <ul className="mt-2 flex flex-col gap-2">
            {rows.map((comment) => (
              <li key={comment.id}>
                <CommentCard comment={comment} pageId={pageId} />
              </li>
            ))}
          </ul>
        )}
      </Async>

      <form
        className="mt-md flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.trim()) add.submit(draft.trim());
        }}
      >
        <TextArea
          label="Add a comment"
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          rows={3}
          {...(add.error ? { error: add.error } : {})}
        />
        <div>
          <Button
            type="submit"
            variant="primary"
            busy={add.busy}
            busyLabel="Posting…"
            disabled={!draft.trim()}
          >
            Comment
          </Button>
        </div>
      </form>
    </section>
  );
}

function CommentCard({ comment, pageId }: { comment: Comment; pageId: string }) {
  const resolved = comment.resolvedAt !== null;
  const toggle = useCanonMutation({
    run: () => (resolved ? api.reopenComment(comment.id) : api.resolveComment(comment.id)),
    invalidates: [keys.pages.comments(pageId)],
    announce: () => (resolved ? "Comment reopened." : "Comment resolved."),
  });

  return (
    <div className={`card p-md ${resolved ? "opacity-70" : ""}`}>
      <div className="flex flex-wrap items-center gap-2 text-meta text-muted">
        {/* A send-back is not an ordinary comment: it is the reason a draft came
            back, and burying it in the thread is how an author misses it. */}
        {comment.sentBack ? (
          <span className="rounded-sm bg-warn/12 px-1.5 py-0.5 font-medium text-warn">
            Sent back
          </span>
        ) : null}
        {comment.authorKind === "agent" ? (
          <span className="rounded-sm bg-surface-2 px-1.5 py-0.5">agent</span>
        ) : null}
        <span>{formatAgo(comment.createdAt) ?? ""}</span>
        {resolved ? <span>· resolved</span> : null}
      </div>

      <p className="mt-1 whitespace-pre-wrap text-ui text-text">{comment.body}</p>

      <div className="mt-2">
        <Button busy={toggle.busy} busyLabel="Working…" onClick={() => toggle.submit(undefined)}>
          {resolved ? "Reopen" : "Resolve"}
        </Button>
      </div>
      {toggle.error ? (
        <p role="alert" className="mt-1 text-meta text-danger">
          {toggle.error}
        </p>
      ) : null}
    </div>
  );
}
