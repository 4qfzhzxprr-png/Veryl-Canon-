import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Async } from "@/components/Async";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { TextArea } from "@/components/Field";
import { Modal } from "@/components/Modal";
import { Skeleton } from "@/components/Skeleton";
import { StatusTag } from "@/components/StatusTag";
import { api } from "@/lib/api";
import { formatAgo, plural, TYPE_LABELS } from "@/lib/format";
import { keys } from "@/lib/queryKeys";
import { useCanonMutation } from "@/lib/useCanonMutation";
import type { Notice, QueuedPage, WorkQueue } from "@/types/api";

/**
 * One person's own work, and the first screen in this client that CHANGES the
 * record.
 *
 * USER-TESTING.md T2.1: "There isn't one. Five nav items, none scoped to me. I
 * found my work by walking five collection sidebars, eyeballing 44 badges, and
 * opening every one of those 44 pages to read the Approver field. 25 were mine.
 * Did I believe I'd found all of it? No, and I still don't."
 *
 * The count is most of the value and it is the cheapest thing here. He did not
 * fail to find a page; he failed to be told there was anything to find.
 *
 * Everything comes from ONE call. The strands are assembled server-side from
 * reads that filter by permission in their SELECT, so this screen composes
 * nothing and asks about nobody — there is no actor parameter to send, and no
 * `queueFor(someone_else)` to accidentally build.
 */
export function Queue() {
  const query = useQuery({ queryKey: keys.queue, queryFn: api.queue });

  return (
    <div className="mx-auto max-w-[900px] px-md py-lg sm:px-lg">
      <h1 className="mb-1 font-sans text-title font-bold">My queue</h1>
      <p className="mb-lg text-ui text-muted">
        Everything waiting on you, in one place. Nothing here is somebody else&rsquo;s work.
      </p>

      <Async
        query={query}
        loadingLabel="Loading your queue"
        skeleton={
          <div className="flex flex-col gap-3" aria-hidden>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} variant="card" label="Loading your work" />
            ))}
          </div>
        }
        isEmpty={(q) => q.counts.total === 0 && q.notices.length === 0}
        empty={
          <EmptyState
            title="Nothing is waiting on you"
            body="No page needs your approval, no draft has been sent back, and nothing you own is past its review date. Work appears here on its own — you do not have to go looking for it."
          />
        }
      >
        {(queue) => <Strands queue={queue} />}
      </Async>
    </div>
  );
}

function Strands({ queue }: { queue: WorkQueue }) {
  return (
    <div className="flex flex-col gap-lg">
      {/* A strand hit its limit, so these lists are a floor rather than a
          total. Said out loud, because a list silently capped at 100 reads as
          "that is all of it" — which is the exact belief this screen exists to
          replace. */}
      {queue.truncated ? (
        <p role="status" className="rounded-md bg-warn/10 px-3 py-2 text-ui text-warn">
          There is more than this screen shows. The counts are exact; the lists stop at 100.
        </p>
      ) : null}

      <Strand
        title="Waiting for your approval"
        blurb="You are the named approver. Nobody else can move these."
        pages={queue.awaitingMyApproval}
        actions
      />
      <Strand
        title="Sent back to you"
        blurb="An approver returned these with a comment. They are yours again."
        pages={queue.sentBackToMe}
      />
      <Strand
        title="Yours, past review"
        blurb={`Pages you own whose review date has passed, judged against ${queue.at}.`}
        pages={queue.myPagesPastReview}
      />
      <Strand
        title="Your drafts"
        blurb="Work in progress that nobody is waiting on yet."
        pages={queue.myDrafts}
      />
      {/* Deliberately below the counted strands and never in the badge: it is
          waiting on somebody else, and a number you cannot clear is ignored
          within a week. */}
      <Strand
        title="Waiting on somebody else"
        blurb="You submitted these. There is nothing for you to do until they answer."
        pages={queue.awaitingSomebodyElse}
      />

      {queue.notices.length ? <Notices notices={queue.notices} /> : null}
    </div>
  );
}

function Strand({
  title,
  blurb,
  pages,
  actions = false,
}: {
  title: string;
  blurb: string;
  pages: QueuedPage[];
  actions?: boolean;
}) {
  // An empty strand is not rendered at all. Five headings each saying "none"
  // is a screen that looks full of nothing, and it buries the one strand that
  // does have work in it.
  if (pages.length === 0) return null;

  return (
    <section aria-labelledby={`strand-${title.replace(/\W+/g, "-")}`}>
      <h2 id={`strand-${title.replace(/\W+/g, "-")}`} className="text-ui font-semibold">
        {title} <span className="text-muted">({pages.length})</span>
      </h2>
      <p className="mt-0.5 text-meta text-muted">{blurb}</p>
      <ul className="mt-2 flex flex-col gap-1.5">
        {pages.map((page) => (
          <li key={page.pageId}>
            <QueueRow page={page} actions={actions} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function QueueRow({ page, actions }: { page: QueuedPage; actions: boolean }) {
  return (
    <div className="card flex flex-col gap-2 p-md">
      <div className="flex flex-wrap items-start gap-2">
        <a
          href={`#/pages/${page.pageId}`}
          className="min-w-0 flex-1 truncate text-ui font-medium text-action hover:underline"
        >
          {page.title}
        </a>
        <span className="shrink-0 text-meta text-muted">
          {TYPE_LABELS[page.type] ?? page.type}
        </span>
        <StatusTag status={page.status} />
      </div>

      <p className="text-meta text-muted">Last changed {formatAgo(page.updatedAt) ?? "—"}</p>

      {/* The flags an auditor asks about, said on the row rather than only on
          the page. A backdated policy with no stated basis is the single most
          expensive thing to discover late. */}
      <div className="flex flex-wrap gap-2 text-meta">
        {page.backdatedWithoutBasis ? (
          <span className="rounded-sm bg-warn/12 px-1.5 py-0.5 text-warn">
            Backdated, no stated basis
          </span>
        ) : page.backdated ? (
          <span className="rounded-sm bg-surface-2 px-1.5 py-0.5 text-muted">Backdated</span>
        ) : null}
        {page.notYetInForce ? (
          <span className="rounded-sm bg-surface-2 px-1.5 py-0.5 text-muted">
            Not yet in force
          </span>
        ) : null}
        {page.pastReview ? (
          <span className="rounded-sm bg-warn/12 px-1.5 py-0.5 text-warn">Past review</span>
        ) : null}
      </div>

      {actions ? <ReviewActions page={page} /> : null}
    </div>
  );
}

/**
 * Approve, or send it back.
 *
 * **No optimistic update.** An approval that appears to have succeeded and did
 * not is a lie about the record, and the record has no way to un-approve
 * something. The row moves when the server says it moved — which is why the
 * queue key is invalidated rather than the row being spliced out here.
 */
function ReviewActions({ page }: { page: QueuedPage }) {
  const [sendingBack, setSendingBack] = useState(false);

  // Neither mutation renders its own announcement: the shell's live region
  // does, and it is outside this row. Announcing from here was the bug — the
  // approval succeeds, the queue refetches, this row unmounts, and the sentence
  // goes with it before anything reads it out.
  const approve = useCanonMutation({
    run: () => api.approve(page.pageId),
    invalidates: [keys.queue, keys.pages.one(page.pageId), keys.collections.all],
    announce: () => `"${page.title}" approved. It is now the canonical answer.`,
  });

  const sendBack = useCanonMutation({
    run: (note: string) => api.sendBack(page.pageId, note),
    invalidates: [keys.queue, keys.pages.one(page.pageId)],
    announce: () => `"${page.title}" sent back to its author.`,
    onDone: () => setSendingBack(false),
  });

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          busy={approve.busy}
          busyLabel="Approving…"
          // Disabled during EITHER write: sending something back while an
          // approval is in flight is two decisions about one page.
          disabled={sendBack.busy}
          onClick={() => approve.submit(undefined)}
        >
          Approve
        </Button>
        <Button disabled={approve.busy} onClick={() => setSendingBack(true)}>
          Send back
        </Button>
      </div>

      {approve.error ? (
        <p role="alert" className="text-ui text-danger">
          {approve.error}
        </p>
      ) : null}

      <Modal
        open={sendingBack}
        title={`Send back "${page.title}"`}
        description="The author gets your note and the draft returns to them. Say what needs to change — a send-back with no reason is a round trip nobody can act on."
        onClose={() => {
          sendBack.reset();
          setSendingBack(false);
        }}
        submitLabel="Send back"
        busy={sendBack.busy}
        error={sendBack.error}
        onSubmit={(event) => {
          const note = String(new FormData(event.currentTarget).get("note") ?? "").trim();
          sendBack.submit(note);
        }}
      >
        <TextArea name="note" label="What needs to change" required rows={4} />
      </Modal>
    </>
  );
}

/**
 * The outbox, at last rendered somewhere.
 *
 * Uncounted on purpose: there is no read state on a notice, so a badge counting
 * these would be a number that never goes down.
 */
function Notices({ notices }: { notices: Notice[] }) {
  return (
    <section aria-labelledby="notices">
      <h2 id="notices" className="text-ui font-semibold">
        Recent notices
      </h2>
      <p className="mt-0.5 text-meta text-muted">
        {plural(notices.length, "message")} Canon sent you. Nothing here is waiting on a
        decision.
      </p>
      <ul className="mt-2 flex flex-col gap-1.5">
        {notices.map((notice) => {
          // The only shape a notice links to is `/pages/<id>`, sometimes with a
          // comment fragment. Turned into this client's address rather than
          // followed as a server path, which would leave the app.
          const pageId = notice.link?.match(/^\/pages\/([^/#?]+)/)?.[1];
          const body = (
            <>
              <div className="text-ui text-text">{notice.subject}</div>
              <div className="text-meta text-muted">{notice.body}</div>
              <div className="text-meta text-muted">{formatAgo(notice.createdAt) ?? ""}</div>
            </>
          );
          return (
            <li key={notice.id} className="card p-md">
              {pageId ? (
                <a href={`#/pages/${pageId}`} className="block hover:underline">
                  {body}
                </a>
              ) : (
                body
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
