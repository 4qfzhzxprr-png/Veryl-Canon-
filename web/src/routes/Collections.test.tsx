// The four states every screen has, tested on the one screen that proves the
// pattern. If these hold here they hold everywhere, because every other route
// gets them from <Async> rather than writing its own.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { Collections } from "./Collections";
import { ApiError } from "@/lib/errors";
import { api } from "@/lib/api";
import type { Collection } from "@/types/api";

/** A collection exactly as the server sends one — read off a running Canon,
 *  not invented. The first version of this fixture had four fields the server
 *  does not send and was missing five it does. */
function collection(over: Partial<Collection> = {}): Collection {
  return {
    id: "c1",
    name: "Compliance",
    description: "Policies",
    restricted: false,
    createdAt: "2026-05-01T09:00:00.000Z",
    archivedAt: null,
    archivedPages: 0,
    abilities: {
      collectionId: "c1",
      role: "author",
      createPage: { can: true, why: null },
      addMember: { can: false, why: "Requires admin access to this collection." },
      removeMember: { can: false, why: null },
      assertRelation: { can: true, why: null },
      runImport: { can: false, why: null },
    },
    ...over,
  };
}

function renderWith() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Collections />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Collections", () => {
  it("announces the wait instead of leaving it silent", async () => {
    vi.spyOn(api, "collections").mockReturnValue(new Promise(() => {}));
    renderWith();
    // A sighted user sees shimmering blocks; without this a screen-reader user
    // sees nothing at all until the content arrives.
    expect(await screen.findByText("Loading your collections")).toBeInTheDocument();
  });

  it("says what an empty workspace means, not just that it is empty", async () => {
    vi.spyOn(api, "collections").mockResolvedValue([]);
    renderWith();
    expect(await screen.findByText("The record starts here")).toBeInTheDocument();
    // The invitation, not only the absence — "no collections" alone reads as
    // broken to somebody who has just signed in.
    expect(screen.getByRole("button", { name: /create your first collection/i })).toBeInTheDocument();
  });

  it("offers a retry for a failure that could succeed", async () => {
    vi.spyOn(api, "collections").mockRejectedValue(new ApiError(503, "down"));
    renderWith();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("does not offer a retry for a failure that cannot", async () => {
    // Retrying a 403 reproduces the same error, which teaches people the
    // product is unreliable rather than that they lack access.
    vi.spyOn(api, "collections").mockRejectedValue(new ApiError(403, "nope"));
    renderWith();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
    expect(screen.getByText(/administrator can grant it/i)).toBeInTheDocument();
  });

  it("renders what the server sent, and links to the address the record uses", async () => {
    vi.spyOn(api, "collections").mockResolvedValue([collection()]);
    renderWith();
    expect(await screen.findByText("Compliance")).toBeInTheDocument();
    // `#/collections/:id` is the ORIGINAL client's address for this, so a link
    // followed here works whichever client is serving.
    expect(screen.getByRole("link", { name: /Compliance/ })).toHaveAttribute(
      "href",
      "#/collections/c1",
    );
  });

  it("explains what Restricted means rather than only labelling it", async () => {
    // The word promises the one thing it does not do: a restricted and an
    // unrestricted collection are identically invisible to a non-member.
    vi.spyOn(api, "collections").mockResolvedValue([collection({ restricted: true })]);
    renderWith();
    // Found by the explanation, not by the word: the word alone is what the
    // tag USED to be, and it is the word that misleads. Note also that this
    // cannot be `findByText("Restricted")` — the new-collection dialog has a
    // checkbox with that label, and matching either one would pass.
    // Scoped to the card, because the new-collection dialog carries the same
    // sentence under its checkbox — a global match would pass on either.
    const card = await screen.findByRole("link", { name: /Compliance/ });
    expect(card).toHaveTextContent(/not extra access control/);
    // ...and still available to a pointer, which is what a title is for.
    expect(card.querySelector("[title]")).toHaveAttribute(
      "title",
      expect.stringContaining("not extra access control"),
    );
  });

  it("says a collection has no description rather than leaving a gap", async () => {
    vi.spyOn(api, "collections").mockResolvedValue([collection({ description: "" })]);
    renderWith();
    expect(await screen.findByText("No description.")).toBeInTheDocument();
  });
});
