import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Async } from "@/components/Async";
import { Button } from "@/components/Button";
import { CheckField, TextArea, TextField } from "@/components/Field";
import { EmptyState } from "@/components/EmptyState";
import { Modal } from "@/components/Modal";
import { Skeleton } from "@/components/Skeleton";
import { api } from "@/lib/api";
import { keys } from "@/lib/queryKeys";
import { useCanonMutation } from "@/lib/useCanonMutation";
import { formatDate } from "@/lib/format";
import type { Collection } from "@/types/api";

/**
 * The record's front page: every collection this actor can reach.
 *
 * This is Canon's `#/` — the same address the original client's `viewHome`
 * answered, not a new one. It was written at `#/collections` first, which is a
 * route the original client does not have, so a reader following the tab bar
 * would have crossed to the classic client and landed somewhere else entirely.
 */
export function Collections() {
  const query = useQuery({ queryKey: keys.collections.all, queryFn: api.collections });
  const [creating, setCreating] = useState(false);

  return (
    <div className="mx-auto max-w-[900px] px-md py-lg sm:px-lg">
      <div className="mb-lg flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="mb-1 font-sans text-title font-bold">Collections</h1>
          <p className="text-ui text-muted">
            Every collection you can reach, and what is inside it.
          </p>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          New collection
        </Button>
      </div>

      <Async
        query={query}
        loadingLabel="Loading your collections"
        skeleton={
          <ul className="grid gap-2 sm:grid-cols-2" aria-hidden>
            {[0, 1, 2, 3].map((i) => (
              <li key={i}>
                <Skeleton variant="card" label="Loading a collection" />
              </li>
            ))}
          </ul>
        }
        isEmpty={(rows) => rows.length === 0}
        empty={
          <EmptyState
            title="The record starts here"
            body="Collections hold your organization's knowledge: one per team, department, or domain. Create the first collection, then add pages of the four Core types — Policy, Spec, Plan, and Note."
            action={
              <Button variant="primary" onClick={() => setCreating(true)}>
                Create your first collection
              </Button>
            }
          />
        }
      >
        {(rows) => (
          <ul className="grid gap-2 sm:grid-cols-2">
            {rows.map((c) => (
              <li key={c.id}>
                <CollectionCard collection={c} />
              </li>
            ))}
          </ul>
        )}
      </Async>

      <NewCollectionDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

/** Small, presentational, and testable without a router or a server — which is
 *  the whole argument for components over a 10,000-line render function. */
export function CollectionCard({ collection }: { collection: Collection }) {
  return (
    <a
      href={`#/collections/${collection.id}`}
      className="card flex h-full flex-col gap-1 p-md transition-colors hover:border-action/40"
    >
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 font-medium text-text">{collection.name}</span>
        {collection.restricted ? <RestrictedTag /> : null}
      </div>
      <p className="line-clamp-2 text-meta text-muted">
        {collection.description || "No description."}
      </p>
      <p className="mt-auto pt-2 text-meta text-muted">
        Created {formatDate(collection.createdAt)}
      </p>
    </a>
  );
}

/**
 * The word promises the one thing it does not do, so the tag carries what it
 * actually means. A restricted and an unrestricted collection are IDENTICALLY
 * invisible to a non-member — membership is the whole of access control on
 * every collection, restricted or not.
 */
const RESTRICTED_MEANS =
  "Extra scrutiny, not extra access control: every read here is recorded, including refused ones, and these pages are held back from outside AI services.";

function RestrictedTag() {
  return (
    <span
      className="shrink-0 rounded-sm bg-surface-2 px-2 py-0.5 text-meta text-muted"
      // A `title` is a hover tooltip and nothing else: it never appears on a
      // touch device and screen-reader support for it is inconsistent. It is
      // kept for the mouse, and the sentence is ALSO in the accessible name, so
      // the explanation reaches everybody rather than only people with a
      // pointer.
      title={RESTRICTED_MEANS}
    >
      Restricted
      <span className="sr-only"> — {RESTRICTED_MEANS}</span>
    </span>
  );
}

function NewCollectionDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const create = useCanonMutation({
    run: api.createCollection,
    invalidates: [keys.collections.all],
    announce: (c) => `Collection "${c.name}" created.`,
    onDone: (c) => {
      onClose();
      navigate(`/collections/${c.id}`);
    },
  });

  return (
    <>
      <Modal
        open={open}
        title="New collection"
        onClose={() => {
          create.reset();
          onClose();
        }}
        submitLabel="Create"
        busy={create.busy}
        error={create.error}
        onSubmit={(event) => {
          const form = new FormData(event.currentTarget);
          create.submit({
            name: String(form.get("name") ?? "").trim(),
            description: String(form.get("description") ?? "").trim(),
            restricted: form.get("restricted") === "on",
          });
        }}
      >
        <TextField name="name" label="Name" required maxLength={120} placeholder="e.g. Compliance" />
        <TextArea
          name="description"
          label="Description"
          rows={2}
          hint="What this collection holds. Optional."
        />
        {/* WHAT "RESTRICTED" ACTUALLY DOES, because the word promises the one
            thing it does not do. Round seven, tester 47: a department head
            reading "Restricted" beside a checkbox reasonably concludes it is
            what keeps people out. Two of these sentences were nowhere in the
            product — that it grants no access control, and that it holds these
            pages back from an outside model. */}
        <CheckField
          name="restricted"
          label="Restricted"
          hint="Extra scrutiny, not extra access control. Who can open a collection is decided by its members, restricted or not. Ticking this records every read of a page here — including reads that were refused — and keeps these pages from being sent to an outside AI service, unless this Canon has been set up to allow that."
        />
      </Modal>
    </>
  );
}
