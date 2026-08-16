import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/Button";
import { SelectField, TextField } from "@/components/Field";
import { ErrorState } from "@/components/ErrorState";
import { Skeleton } from "@/components/Skeleton";
import { api, setSession } from "@/lib/api";
import { keys } from "@/lib/queryKeys";
import { useCanonMutation } from "@/lib/useCanonMutation";
import { rememberActor } from "@/lib/actor";
import type { Actor } from "@/types/api";

/**
 * The door.
 *
 * Which door depends on how the server was started, and the screen says which
 * one out loud rather than presenting them as interchangeable. Two are real:
 *
 *   * **single sign-on** — the browser leaves for the organisation's identity
 *     provider and comes back with a session cookie;
 *   * **the development picker** — an unverified `X-Actor-Id` header, live only
 *     where the server was started with `CANON_DEV_AUTH=true`.
 *
 * The picker says it verifies nothing, in those words. A screen that offered a
 * list of colleagues' names to click without saying so would look exactly like
 * a real sign-in, and it is not one.
 */
export function Identity() {
  const session = useQuery({ queryKey: keys.session, queryFn: api.session });

  if (session.isPending) {
    return (
      <Centered>
        <Skeleton variant="block" label="Checking how to sign you in" />
      </Centered>
    );
  }
  if (session.isError) {
    return (
      <Centered>
        <ErrorState error={session.error} onRetry={() => void session.refetch()} />
      </Centered>
    );
  }

  const { sso, devAuth } = session.data;

  if (!devAuth) {
    return (
      <Centered>
        <h1 className="font-sans text-title font-bold">Sign in</h1>
        {sso ? (
          <>
            <p className="mt-2 text-ui text-muted">
              Canon uses your organization&rsquo;s single sign-on. You will be sent to your
              identity provider and returned here.
            </p>
            <SsoButton className="mt-md" />
          </>
        ) : (
          <>
            <p role="alert" className="mt-2 text-ui text-danger">
              No sign-in is configured on this server.
            </p>
            <p className="mt-2 text-ui text-muted">
              An administrator sets <code>CANON_OIDC_ISSUER</code> for single sign-on, or{" "}
              <code>CANON_DEV_AUTH=true</code> for the development identity picker.
            </p>
          </>
        )}
      </Centered>
    );
  }

  return <DevPicker sso={sso} />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex max-w-[520px] flex-col px-md py-2xl sm:px-lg">
      <div className="card p-lg">{children}</div>
    </div>
  );
}

/**
 * `return` carries where they were going, so a reader who deep-linked into a
 * page and was bounced here lands back on that page rather than on the front
 * one. The leading slash is what the server expects; the fragment is preserved
 * because in this app the fragment IS the address.
 */
function SsoButton({ className = "" }: { className?: string }) {
  const back = window.location.hash && window.location.hash !== "#/identity"
    ? window.location.hash
    : "#/";
  return (
    <Button
      variant="primary"
      className={className}
      onClick={() => {
        window.location.href = `/auth/login?return=${encodeURIComponent(`/${back}`)}`;
      }}
    >
      Sign in with your organization account
    </Button>
  );
}

function DevPicker({ sso }: { sso: boolean }) {
  const actors = useQuery({ queryKey: keys.devActors, queryFn: api.devActors });
  const [kind, setKind] = useState<"person" | "agent">("person");
  const choose = useChooseActor();

  const create = useCanonMutation({
    run: api.createActor,
    invalidates: [keys.devActors],
    onDone: (actor) => choose(actor),
  });

  return (
    <Centered>
      <h1 className="font-sans text-title font-bold">Who are you?</h1>
      <p className="mt-2 text-ui text-muted">
        Development sign-in. Identity travels as the <code>X-Actor-Id</code> header and{" "}
        <strong className="text-text">nothing about it is verified</strong> — this server was
        started with <code>CANON_DEV_AUTH=true</code>. Agents authenticate with an Agent
        Passport instead.
      </p>

      {sso ? <SsoButton className="mt-md" /> : null}

      {actors.isError ? (
        <div className="mt-md">
          <ErrorState error={actors.error} onRetry={() => void actors.refetch()} />
        </div>
      ) : null}

      <div className="mt-md flex flex-col gap-1.5">
        {actors.isPending ? (
          <Skeleton variant="block" label="Loading the people this server knows" />
        ) : actors.data?.length ? (
          actors.data.map((actor) => (
            <button
              key={actor.id}
              type="button"
              onClick={() => choose(actor)}
              className="flex min-h-[44px] items-center gap-2 rounded-md border border-border px-3 py-2 text-left hover:bg-surface-2"
            >
              <span className="min-w-0 flex-1 truncate text-ui font-medium">{actor.name}</span>
              <span className="shrink-0 rounded-sm bg-surface-2 px-2 py-0.5 text-meta text-muted">
                {actor.kind}
              </span>
            </button>
          ))
        ) : actors.isSuccess ? (
          <p className="text-ui text-muted">
            No one is registered yet. Create the first actor below.
          </p>
        ) : null}
      </div>

      <hr className="my-lg border-border" />

      <h2 className="text-ui font-semibold">New actor</h2>
      <form
        className="mt-3 flex flex-col gap-md"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const email = String(form.get("email") ?? "").trim();
          const registryRef = String(form.get("registryRef") ?? "").trim();
          create.submit({
            name: String(form.get("name") ?? "").trim(),
            kind,
            ...(email ? { email } : {}),
            ...(kind === "agent" && registryRef ? { registryRef } : {}),
          });
        }}
      >
        <TextField name="name" label="Name" required maxLength={120} placeholder="e.g. Dana Whitfield" />
        <TextField name="email" label="Email" type="email" hint="Optional." />
        <SelectField
          name="kind"
          label="Kind"
          value={kind}
          onChange={(event) => setKind(event.currentTarget.value as "person" | "agent")}
        >
          <option value="person">Person</option>
          <option value="agent">Agent</option>
        </SelectField>
        {/* Shown only for an agent, because a registry reference on a person is
            not a field they can fill in wrongly — it is one that should not be
            there at all. */}
        {kind === "agent" ? (
          <TextField
            name="registryRef"
            label="Registry reference (Agent Passport)"
            placeholder="e.g. passport:acme/helper-1"
          />
        ) : null}
        {create.error ? (
          <p role="alert" className="text-ui text-danger">
            {create.error}
          </p>
        ) : null}
        <div>
          <Button type="submit" variant="primary" busy={create.busy} busyLabel="Creating…">
            Create and continue
          </Button>
        </div>
      </form>
    </Centered>
  );
}

/** Remember who they said they are, refresh the session, and go on to whatever
 *  they were trying to reach. */
function useChooseActor() {
  const client = useQueryClient();
  const navigate = useNavigate();
  return (actor: Actor) => {
    rememberActor(actor);
    // The fetch layer needs it immediately: the very next query carries the
    // header, and waiting for the session query to settle would send that one
    // unauthenticated.
    setSession({
      mode: "dev",
      sso: false,
      devAuth: true,
      authenticated: true,
      viaCookie: false,
      actor,
      orgRole: null,
      csrfToken: null,
      csrfHeader: "x-canon-csrf",
      loginUrl: null,
    });
    void client.invalidateQueries();
    navigate("/", { replace: true });
  };
}
