// The four states every screen has, tested on the one screen that proves the
// pattern. If these hold here they hold everywhere, because every other route
// gets them from <Async> rather than writing its own.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Collections } from "./Collections";
import { ApiError } from "@/lib/errors";
import { api } from "@/lib/api";

function renderWith() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <Collections />
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
    expect(await screen.findByText("No collections yet")).toBeInTheDocument();
    // The invitation, not only the absence — "no collections" alone reads as
    // broken to somebody who has just signed in.
    expect(screen.getByText(/canonical answer/i)).toBeInTheDocument();
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

  it("renders what it is told, including the role the server resolved", async () => {
    vi.spyOn(api, "collections").mockResolvedValue([
      { id: "c1", name: "Compliance", description: "Policies", role: "reviewer",
        pageCount: 1, updatedAt: "" },
    ]);
    renderWith();
    expect(await screen.findByText("Compliance")).toBeInTheDocument();
    expect(screen.getByText("1 page")).toBeInTheDocument();   // not "1 pages"
    expect(screen.getByText("reviewer")).toBeInTheDocument();
  });
});
