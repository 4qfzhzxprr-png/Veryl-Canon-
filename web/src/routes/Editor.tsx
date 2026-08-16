import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { SelectField, TextArea, TextField } from "@/components/Field";
import { Markdown } from "@/components/Markdown";
import { Modal } from "@/components/Modal";
import { Skeleton } from "@/components/Skeleton";
import { api } from "@/lib/api";
import { ApiError } from "@/lib/errors";
import { formatDateTime, TYPE_LABELS } from "@/lib/format";
import { keys } from "@/lib/queryKeys";
import { saveStateLabel, useDraftAutosave } from "@/lib/useDraftAutosave";
import { useCanonMutation } from "@/lib/useCanonMutation";
import type { Actor, Draft, PageDetail } from "@/types/api";
import { REVIEWED_TYPES, TYPE_FIELDS } from "@/types/api";

interface DraftForm {
  title: string;
  body: string;
  ownerId: string;
  approverId: string;
  effectiveDate: string;
  effectiveDateBasis: string;
  reviewDate: string;
}

/**
 * Writing a page.
 *
 * Two things here are deliberately NOT what the original client did, and both
 * are about not losing work: the draft autosaves on a pause
 * (`useDraftAutosave`), and leaving with unsaved changes is guarded. The
 * original saved once to claim the lock and then only on an explicit press,
 * with no `beforeunload` — an afternoon of writing lived in a textarea and
 * nowhere else.
 *
 * What is faithfully kept is the server's own contract, because it encodes
 * decisions that cost somebody a round of user testing: **opening writes
 * nothing and locks nothing**, and the lock is taken by the first save that
 * carries content. Walking in the door used to create a draft row, put an
 * untyped draft in the queue and the audit log, and lock out every other
 * editor.
 */
export function Editor() {
  const { id = "" } = useParams();
  const page = useQuery({ queryKey: keys.pages.one(id), queryFn: () => api.page(id) });
  // The opening question. It writes nothing, so re-asking on a retry is free —
  // and it is the call that refuses 423 when somebody else holds the page.
  const opened = useQuery({
    queryKey: [...keys.pages.one(id), "draft", "open"],
    queryFn: () => api.openDraft(id),
    retry: false,
    // Never refetched behind the author's back: a background refresh would
    // replace what they are typing with what the server last heard.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  if (opened.isError) return <CannotEdit id={id} error={opened.error} onRetry={() => void opened.refetch()} />;
  if (page.isError) return <ErrorState error={page.error} onRetry={() => void page.refetch()} />;
  if (!opened.data || !page.data) {
    return (
      <div className="mx-auto max-w-[900px] px-md py-lg sm:px-lg">
        <Skeleton variant="block" label="Opening the editor" />
      </div>
    );
  }

  return <EditorForm page={page.data} draft={opened.data} pageId={id} />;
}

/**
 * Somebody else has it, or it cannot be edited at all.
 *
 * A lock is not an error to apologise for — it is the mechanism that stops two
 * people overwriting each other — so it says who holds it and what will make it
 * available, rather than showing a stack of red.
 */
function CannotEdit({
  id,
  error,
  onRetry,
}: {
  id: string;
  error: unknown;
  onRetry: () => void;
}) {
  const locked = error instanceof ApiError && error.status === 423;
  const who = locked ? /edited by (.+)$/.exec(error.message)?.[1] : null;

  if (!locked && !(error instanceof ApiError && error.status === 422)) {
    return (
      <div className="mx-auto max-w-[700px] px-md py-lg sm:px-lg">
        <ErrorState error={error} onRetry={onRetry} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[700px] px-md py-lg sm:px-lg">
      <EmptyState
        title={locked ? `Being edited by ${who ?? "somebody else"}` : "Not editable right now"}
        body={
          locked
            ? `${error instanceof ApiError ? error.message : ""}. Canon keeps drafts to one editor at a time, so nothing is overwritten. Try again once they publish or discard.`
            : error instanceof ApiError
              ? error.message
              : ""
        }
        action={
          <div className="flex flex-wrap gap-2">
            <a
              className="inline-flex min-h-[44px] items-center rounded-md border border-border px-3 text-ui hover:bg-surface-2"
              href={`#/pages/${id}`}
            >
              Back to the page
            </a>
            {locked ? <Button onClick={onRetry}>Try again</Button> : null}
          </div>
        }
      />
    </div>
  );
}

function EditorForm({ page, draft, pageId }: { page: PageDetail; draft: Draft; pageId: string }) {
  const navigate = useNavigate();
  const rules = TYPE_FIELDS[page.type];
  const reviewed = REVIEWED_TYPES.includes(page.type);

  const [form, setForm] = useState<DraftForm>({
    title: draft.title,
    body: draft.body,
    ownerId: draft.fields.ownerId ?? "",
    approverId: draft.fields.approverId ?? "",
    effectiveDate: draft.fields.effectiveDate ?? "",
    effectiveDateBasis: draft.fields.effectiveDateBasis ?? "",
    reviewDate: draft.fields.reviewDate ?? "",
  });
  const [preview, setPreview] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [warnings, setWarnings] = useState({ alias: draft.warnings, link: draft.linkWarnings });

  const people = useQuery({
    queryKey: [...keys.actors, page.collectionId],
    queryFn: () => api.actors(page.collectionId),
  });

  const autosave = useDraftAutosave<DraftForm>({
    save: async (value) => {
      const saved = await api.saveDraft(pageId, {
        title: value.title.trim(),
        body: value.body,
        fields: {
          ownerId: value.ownerId || null,
          approverId: value.approverId || null,
          effectiveDate: value.effectiveDate || null,
          effectiveDateBasis: value.effectiveDateBasis || null,
          reviewDate: value.reviewDate || null,
        },
      });
      // Replaced wholesale each save, so a collision the author has just
      // removed stops being claimed.
      setWarnings({ alias: saved.warnings, link: saved.linkWarnings });
      return saved;
    },
  });

  const set = <K extends keyof DraftForm>(key: K, value: DraftForm[K]) => {
    const next = { ...form, [key]: value };
    setForm(next);
    autosave.changed(next);
  };

  // In-app navigation, which `beforeunload` does not cover: a hash change is
  // not a page load, so following a link inside the app would take unsaved
  // work with it silently.
  useUnsavedGuard(autosave.unsaved);

  const submit = useCanonMutation({
    run: async () => {
      // Always saved first. Submitting what the server last heard rather than
      // what is on screen is the quiet way to send a reviewer the wrong draft.
      await autosave.saveNow();
      return api.submit(pageId);
    },
    invalidates: [keys.pages.one(pageId), keys.queue],
    announce: () => `"${form.title}" submitted for review.`,
    onDone: () => navigate(`/pages/${pageId}`),
  });

  const publish = useCanonMutation({
    run: async (note: string) => {
      await autosave.saveNow();
      return api.publish(pageId, note);
    },
    invalidates: [keys.pages.one(pageId), keys.pages.versions(pageId), keys.queue],
    announce: () => `"${form.title}" published.`,
    onDone: () => {
      setPublishing(false);
      navigate(`/pages/${pageId}`);
    },
  });

  return (
    <div className="mx-auto max-w-[900px] px-md py-lg sm:px-lg">
      <p className="mb-2 text-meta">
        <a className="text-action hover:underline" href={`#/pages/${pageId}`}>
          ← Back to the page
        </a>
      </p>

      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="font-sans text-title font-bold">
          Editing <span className="font-normal text-muted">({TYPE_LABELS[page.type]})</span>
        </h1>
        <SaveStatus autosave={autosave} />
      </div>

      {/* The persistent trace of a failed save. A refusal that lives only in a
          transient toast is one the author can miss, after which a status line
          keeps vouching for work the server threw away. */}
      {autosave.state.kind === "failed" ? (
        <p role="alert" className="mt-2 rounded-md bg-danger/10 px-3 py-2 text-ui text-danger">
          {saveStateLabel(autosave.state)}
        </p>
      ) : null}

      {page.status === "canonical" ? (
        <p className="mt-md rounded-md bg-surface-2 px-3 py-2 text-ui text-muted">
          This page is Canonical. <strong className="text-text">Submit for review</strong> keeps
          it that way — readers and Ask keep the approved version until the approver accepts
          your changes. Publishing instead makes the new text live at once and gives the mark
          up until it passes review again.
        </p>
      ) : null}

      {draft.baseVersion !== null ? (
        <p className="mt-2 text-meta text-muted">
          This is a change to version {draft.baseVersion}.
        </p>
      ) : null}

      <form className="mt-lg flex flex-col gap-md" onSubmit={(event) => event.preventDefault()}>
        <TextField
          label="Title"
          required
          maxLength={200}
          value={form.title}
          onChange={(event) => set("title", event.currentTarget.value)}
        />

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-ui font-medium text-text">Body</span>
            <Button
              onClick={() => setPreview((p) => !p)}
              aria-pressed={preview}
              className="min-h-[36px]"
            >
              {preview ? "Write" : "Preview"}
            </Button>
          </div>
          {preview ? (
            // Exactly the component a reader meets, not a second renderer that
            // drifts from it.
            <div className="min-h-[320px] rounded-md border border-border p-3">
              <Markdown body={form.body} />
            </div>
          ) : (
            <TextArea
              label="Body"
              className="min-h-[320px] font-mono"
              value={form.body}
              spellCheck
              onChange={(event) => set("body", event.currentTarget.value)}
            />
          )}
        </div>

        {warnings.link.length ? (
          <ul className="rounded-md bg-warn/10 px-3 py-2 text-meta text-warn">
            {warnings.link.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        ) : null}
        {warnings.alias.length ? (
          <ul className="rounded-md bg-warn/10 px-3 py-2 text-meta text-warn">
            {warnings.alias.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        ) : null}

        {/* Only the fields this type actually carries. A mirror of the server's
            rules, never a gate — it still refuses a Policy with no review date
            whatever this form shows. */}
        {rules.owner ? (
          <PersonField
            label="Owner"
            hint="Who is accountable for what this says."
            value={form.ownerId}
            people={people.data ?? []}
            onChange={(value) => set("ownerId", value)}
          />
        ) : null}
        {rules.approver ? (
          <PersonField
            label="Approver"
            hint="Who grants the Canonical mark. They cannot be the person who submits it."
            value={form.approverId}
            people={people.data ?? []}
            onChange={(value) => set("approverId", value)}
          />
        ) : null}
        {rules.effectiveDate ? (
          <>
            <TextField
              label="In force from"
              type="date"
              hint="The day what this says began to apply — not the day it was written."
              value={form.effectiveDate}
              onChange={(event) => set("effectiveDate", event.currentTarget.value)}
            />
            {/* Asked for whenever the date is in the past, because that is when
                somebody will one day be asked where it came from and nobody
                will be able to say. */}
            {isBackdated(form.effectiveDate) ? (
              <TextField
                label="Where the effective date comes from"
                hint="A board minute, a contract, a dated announcement. This is the question an auditor asks about a backdated policy."
                value={form.effectiveDateBasis}
                onChange={(event) => set("effectiveDateBasis", event.currentTarget.value)}
              />
            ) : null}
          </>
        ) : null}
        {rules.reviewDate ? (
          <TextField
            label="Next review"
            type="date"
            required={rules.reviewDateRequired === true}
            hint="Canon marks the page Needs Update on its own when this passes."
            value={form.reviewDate}
            onChange={(event) => set("reviewDate", event.currentTarget.value)}
          />
        ) : null}

        <div className="flex flex-wrap gap-2 border-t border-border pt-md">
          <Button
            variant="secondary"
            busy={autosave.state.kind === "saving"}
            busyLabel="Saving…"
            onClick={() => void autosave.saveNow()}
          >
            Save draft
          </Button>
          {reviewed ? (
            <Button
              variant="primary"
              busy={submit.busy}
              busyLabel="Submitting…"
              onClick={() => submit.submit(undefined)}
            >
              Submit for review
            </Button>
          ) : null}
          <Button onClick={() => setPublishing(true)} disabled={publish.busy}>
            Publish now
          </Button>
        </div>

        {submit.error ? (
          <p role="alert" className="text-ui text-danger">
            {submit.error}
          </p>
        ) : null}
      </form>

      <Modal
        open={publishing}
        title="Publish this draft"
        description={
          reviewed
            ? "Publishing makes this text live at once, without review. The page loses the Canonical mark until it passes review again."
            : "Publishing makes this text live at once."
        }
        onClose={() => {
          publish.reset();
          setPublishing(false);
        }}
        submitLabel="Publish"
        busy={publish.busy}
        error={publish.error}
        onSubmit={(event) => {
          publish.submit(String(new FormData(event.currentTarget).get("note") ?? "").trim());
        }}
      >
        <TextArea
          name="note"
          label="Why this version exists"
          rows={3}
          hint="Kept with the version forever. Without it the history is a list of timestamps, and the question people bring to it is never “when” alone."
        />
      </Modal>
    </div>
  );
}

function SaveStatus({ autosave }: { autosave: ReturnType<typeof useDraftAutosave<DraftForm>> }) {
  const label = saveStateLabel(autosave.state);
  const at = autosave.state.kind === "clean" ? autosave.state.at : null;
  return (
    <p
      // Polite, not an alert: a status that interrupted the author mid-sentence
      // every two seconds would be worse than saying nothing.
      role="status"
      aria-live="polite"
      className={`text-meta ${autosave.state.kind === "failed" ? "text-danger" : "text-muted"}`}
    >
      {label}
      {at ? ` ${formatDateTime(at)}` : ""}
    </p>
  );
}

function PersonField({
  label,
  hint,
  value,
  people,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  people: Actor[];
  onChange: (value: string) => void;
}) {
  return (
    <SelectField
      label={label}
      hint={hint}
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
    >
      <option value="">—</option>
      {people.map((person) => (
        <option key={person.id} value={person.id}>
          {person.name}
          {person.kind === "agent" ? " (agent)" : ""}
        </option>
      ))}
    </SelectField>
  );
}

function isBackdated(date: string): boolean {
  if (!date) return false;
  return date < new Date().toISOString().slice(0, 10);
}

/**
 * Stop an in-app navigation from taking unsaved work with it.
 *
 * `beforeunload` covers closing the tab and reloading; it does NOT cover
 * following a link inside this application, because a hash change is not a page
 * load. Without this, the most likely way to lose a draft — clicking a link on
 * the page you are editing — is the one that goes unguarded.
 *
 * `hashchange` rather than a router-level block: the address has already
 * changed by the time it fires, so a refused navigation is put back. That is
 * uglier than intercepting the click and it catches Back, a typed address and
 * a link the router never saw.
 */
function useUnsavedGuard(unsaved: boolean): void {
  const here = useRef(window.location.hash);
  const dirty = useRef(unsaved);
  dirty.current = unsaved;

  useEffect(() => {
    here.current = window.location.hash;
    const onChange = () => {
      if (!dirty.current || window.location.hash === here.current) {
        here.current = window.location.hash;
        return;
      }
      const leaving = window.location.hash;
      // eslint-disable-next-line no-alert
      const go = window.confirm(
        "You have changes that have not been saved. Leave this page and lose them?",
      );
      if (go) {
        here.current = leaving;
        return;
      }
      window.location.hash = here.current;
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
}
