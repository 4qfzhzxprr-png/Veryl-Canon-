import { useQueries } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router-dom";
import { Async } from "@/components/Async";
import { Button } from "@/components/Button";
import { SelectField } from "@/components/Field";
import { Modal } from "@/components/Modal";
import { Skeleton } from "@/components/Skeleton";
import { api } from "@/lib/api";
import { ROLE_LABELS } from "@/lib/format";
import { keys } from "@/lib/queryKeys";
import { useCanonMutation } from "@/lib/useCanonMutation";
import type { Actor, Collection, Member, Role } from "@/types/api";

const ROLES: Role[] = ["view", "comment", "edit", "approve", "admin"];

/**
 * Who can do what in a collection.
 *
 * **The screen where a wrong click is most alarming**, and the one the original
 * client got worst. USER-TESTING T4.4: holding only `edit`, a contributor was
 * shown a fully enabled **Remove** beside every colleague's name and a live Add
 * member form. Pressing Remove produced a three-second toast in the far corner
 * reading "Requires admin access to this collection", and nothing happened. She
 * could not tell whether she had removed somebody.
 *
 * So every control here is drawn from `collection.abilities` — the server's own
 * projection of the checks — and a control it would refuse is greyed and
 * carries the server's sentence rather than being live or absent.
 *
 * Membership is also the WHOLE of access control in Canon. A restricted and an
 * unrestricted collection are identically invisible to a non-member; this
 * screen is where access is actually granted, which is why removing somebody
 * asks first and says what is left afterwards.
 */
export function Members() {
  const { id = "" } = useParams();
  const [collection, members, people] = useQueries({
    queries: [
      { queryKey: keys.collections.one(id), queryFn: () => api.collection(id) },
      { queryKey: [...keys.collections.one(id), "members"], queryFn: () => api.members(id) },
      { queryKey: [...keys.actors, id], queryFn: () => api.actors() },
    ],
  });

  const named = new Map((people.data ?? []).map((actor) => [actor.id, actor]));

  return (
    <div className="mx-auto max-w-[820px] px-md py-lg sm:px-lg">
      <p className="mb-2 text-meta">
        <a className="text-action hover:underline" href={`#/collections/${id}`}>
          ← Back to the collection
        </a>
      </p>
      <h1 className="mb-1 font-sans text-title font-bold">
        Members{collection.data ? ` of ${collection.data.name}` : ""}
      </h1>
      <p className="mb-lg text-ui text-muted">
        Membership is how access works here. Somebody who is not a member cannot open this
        collection at all — restricted or not.
      </p>

      {collection.data ? (
        <AddMember collection={collection.data} people={people.data ?? []} members={members.data ?? []} />
      ) : null}

      <Async
        query={members as typeof members & { data: Member[] }}
        loadingLabel="Loading who belongs to this collection"
        skeleton={
          <div className="mt-lg flex flex-col gap-1.5" aria-hidden>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} variant="line" label="Loading a member" />
            ))}
          </div>
        }
      >
        {(rows) => (
          <ul className="mt-lg flex flex-col gap-1.5">
            {rows.map((member) => (
              <li key={member.actorId}>
                <MemberRow
                  collectionId={id}
                  member={member}
                  actor={named.get(member.actorId)}
                  canAdminister={collection.data?.abilities.removeMember ?? { can: false, why: null }}
                />
              </li>
            ))}
          </ul>
        )}
      </Async>
    </div>
  );
}

function AddMember({
  collection,
  people,
  members,
}: {
  collection: Collection;
  people: Actor[];
  members: Member[];
}) {
  const may = collection.abilities.addMember;
  const [actorId, setActorId] = useState("");
  const [memberRole, setRole] = useState<Role>("view");

  const add = useCanonMutation({
    run: () => api.setMember(collection.id, actorId, memberRole),
    invalidates: [[...keys.collections.one(collection.id), "members"]],
    announce: () =>
      `${people.find((p) => p.id === actorId)?.name ?? "They"} can now ${ROLE_LABELS[memberRole]?.toLowerCase() ?? memberRole} here.`,
    onDone: () => setActorId(""),
  });

  // Already a member: adding them again is a role CHANGE, which the row does.
  const held = new Set(members.map((m) => m.actorId));
  const available = people.filter((person) => !held.has(person.id));

  if (!may.can) {
    // Present and explained rather than absent. A form that vanishes teaches
    // nobody what they would need in order to use it.
    return (
      <p className="rounded-md bg-surface-2 px-3 py-2 text-ui text-muted">
        {may.why ?? "You cannot change who belongs to this collection."}
      </p>
    );
  }

  return (
    <form
      className="flex flex-wrap items-end gap-3 rounded-md border border-border p-md"
      onSubmit={(event) => {
        event.preventDefault();
        if (actorId) add.submit(undefined);
      }}
    >
      <div className="min-w-[200px] flex-1">
        <SelectField
          label="Add somebody"
          value={actorId}
          onChange={(event) => setActorId(event.currentTarget.value)}
        >
          <option value="">Choose a person</option>
          {available.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
              {person.kind === "agent" ? " (agent)" : ""}
            </option>
          ))}
        </SelectField>
      </div>
      <div className="min-w-[180px]">
        <SelectField
          label="They can"
          value={memberRole}
          onChange={(event) => setRole(event.currentTarget.value as Role)}
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r] ?? r}
            </option>
          ))}
        </SelectField>
      </div>
      <Button type="submit" variant="primary" busy={add.busy} busyLabel="Adding…" disabled={!actorId}>
        Add
      </Button>
      {add.error ? (
        <p role="alert" className="w-full text-ui text-danger">
          {add.error}
        </p>
      ) : null}
    </form>
  );
}

function MemberRow({
  collectionId,
  member,
  actor,
  canAdminister,
}: {
  collectionId: string;
  member: Member;
  actor: Actor | undefined;
  canAdminister: { can: boolean; why: string | null };
}) {
  const [confirming, setConfirming] = useState(false);
  const membersKey = [...keys.collections.one(collectionId), "members"];

  const change = useCanonMutation({
    run: (next: Role) => api.setMember(collectionId, member.actorId, next),
    invalidates: [membersKey],
    announce: (_r, next) =>
      `${actor?.name ?? "They"} can now ${ROLE_LABELS[next]?.toLowerCase() ?? next} here.`,
  });

  const remove = useCanonMutation({
    run: () => api.removeMember(collectionId, member.actorId),
    invalidates: [membersKey],
    // The server answers with what is LEFT, because a directory group may still
    // be granting this person a role here — and an administrator who was not
    // told would believe they had removed something.
    announce: () =>
      `${actor?.name ?? "They"} no longer has a role granted by hand here. A directory group may still grant one.`,
    onDone: () => setConfirming(false),
  });

  return (
    <div className="card flex flex-wrap items-center gap-3 p-md">
      <div className="min-w-0 flex-1">
        <div className="truncate text-ui font-medium text-text">
          {actor?.name ?? member.actorId}
        </div>
        {actor?.kind === "agent" ? (
          <div className="text-meta text-muted">agent</div>
        ) : null}
      </div>

      {canAdminister.can ? (
        <>
          <div className="min-w-[180px]">
            <SelectField
              label={`What ${actor?.name ?? "they"} can do`}
              value={member.role}
              disabled={change.busy || remove.busy}
              onChange={(event) => change.submit(event.currentTarget.value as Role)}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r] ?? r}
                </option>
              ))}
            </SelectField>
          </div>
          <Button variant="danger" disabled={change.busy} onClick={() => setConfirming(true)}>
            Remove
          </Button>
        </>
      ) : (
        <>
          <span className="rounded-sm bg-surface-2 px-2 py-1 text-meta text-muted">
            {ROLE_LABELS[member.role] ?? member.role}
          </span>
          {canAdminister.why ? (
            <span className="w-full text-meta text-muted">{canAdminister.why}</span>
          ) : null}
        </>
      )}

      {change.error ? (
        <p role="alert" className="w-full text-ui text-danger">
          {change.error}
        </p>
      ) : null}

      {/* Asked, not assumed. Removing somebody takes away their access to
          everything in this collection, and there is no undo that restores what
          they could see in the meantime. */}
      <Modal
        open={confirming}
        title={`Remove ${actor?.name ?? "this person"}?`}
        description="They lose access to every page in this collection. You can add them back, but the audit log will show both."
        onClose={() => {
          remove.reset();
          setConfirming(false);
        }}
        submitLabel="Remove"
        busy={remove.busy}
        error={remove.error}
        onSubmit={(event) => {
          event.preventDefault();
          remove.submit(undefined);
        }}
      >
        <p className="text-ui text-muted">
          A directory group may still grant them a role here. If it does, Canon will say so
          when this is done.
        </p>
      </Modal>
    </div>
  );
}
