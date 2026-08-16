// The queue is the first screen in this client that CHANGES the record, so
// these tests are about the write, not the layout. Each one guards a way an
// approval can go wrong that nobody would notice from a screenshot.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Queue } from "./Queue";
import { api } from "@/lib/api";
import { ApiError } from "@/lib/errors";
import { Announcer } from "@/components/Announcer";
import { clearAnnouncement } from "@/lib/announce";
import type { QueuedPage, WorkQueue } from "@/types/api";

function page(over: Partial<QueuedPage> = {}): QueuedPage {
  return {
    pageId: "p1",
    collectionId: "c1",
    type: "policy",
    title: "Parental leave",
    status: "in_review",
    ownerId: "a1",
    reviewDate: null,
    updatedAt: "2026-08-16T19:00:00.000Z",
    pastReview: false,
    backdated: false,
    backdatedWithoutBasis: false,
    notYetInForce: false,
    ...over,
  };
}

function queue(over: Partial<WorkQueue> = {}): WorkQueue {
  return {
    actorId: "a1",
    at: "2026-08-16",
    awaitingMyApproval: [],
    sentBackToMe: [],
    myPagesPastReview: [],
    myDrafts: [],
    awaitingSomebodyElse: [],
    notices: [],
    counts: {
      awaitingMyApproval: 0, sentBackToMe: 0, myPagesPastReview: 0, myDrafts: 0,
      conflictsOnMyPages: 0, divergencesOnMyPages: 0, accessRequests: 0,
      notices: 0, total: 0,
    },
    truncated: false,
    ...over,
  };
}

function renderQueue() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <Queue />
    </QueryClientProvider>,
  );
}

beforeEach(() => clearAnnouncement());

const withWork = () =>
  queue({
    awaitingMyApproval: [page()],
    counts: { ...queue().counts, awaitingMyApproval: 1, total: 1 },
  });

describe("Queue", () => {
  it("says nothing is waiting rather than showing five empty headings", async () => {
    vi.spyOn(api, "queue").mockResolvedValue(queue());
    renderQueue();
    expect(await screen.findByText("Nothing is waiting on you")).toBeInTheDocument();
    expect(screen.queryByText(/Waiting for your approval/)).not.toBeInTheDocument();
  });

  it("hides a strand with nothing in it", async () => {
    vi.spyOn(api, "queue").mockResolvedValue(withWork());
    renderQueue();
    expect(await screen.findByText(/Waiting for your approval/)).toBeInTheDocument();
    // Five headings each saying "none" buries the one that has work in it.
    expect(screen.queryByText(/Your drafts/)).not.toBeInTheDocument();
  });

  it("says the lists are a floor when a strand was capped", async () => {
    // A list silently capped at 100 reads as "that is all of it" — the exact
    // belief this screen exists to replace.
    vi.spyOn(api, "queue").mockResolvedValue({ ...withWork(), truncated: true });
    renderQueue();
    expect(await screen.findByText(/more than this screen shows/i)).toBeInTheDocument();
  });

  it("does not move the row until the server says it moved", async () => {
    // No optimistic update, ever: an approval that appears to have succeeded
    // and did not is a lie about the record, and there is no un-approve.
    let settle: (() => void) | undefined;
    vi.spyOn(api, "queue").mockResolvedValue(withWork());
    vi.spyOn(api, "approve").mockReturnValue(
      new Promise((resolve) => { settle = () => resolve(null); }),
    );

    renderQueue();
    const approve = await screen.findByRole("button", { name: "Approve" });
    await userEvent.click(approve);

    // Still on screen, and the control says what it is doing.
    expect(screen.getByText("Parental leave")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /approving/i })).toBeDisabled();
    settle?.();
  });

  it("refuses a second click while the first is still in flight", async () => {
    // A keyboard repeat, a double tap and a slow network all produce a second
    // call. One approval must not become two.
    vi.spyOn(api, "queue").mockResolvedValue(withWork());
    const approve = vi.spyOn(api, "approve").mockReturnValue(new Promise(() => {}));

    renderQueue();
    const button = await screen.findByRole("button", { name: "Approve" });
    await userEvent.click(button);
    await userEvent.click(button);
    await userEvent.click(button);

    expect(approve).toHaveBeenCalledTimes(1);
  });

  it("locks out Send back while an approval is in flight", async () => {
    // Two decisions about one page is worse than a slow one.
    vi.spyOn(api, "queue").mockResolvedValue(withWork());
    vi.spyOn(api, "approve").mockReturnValue(new Promise(() => {}));

    renderQueue();
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(screen.getByRole("button", { name: "Send back" })).toBeDisabled();
  });

  it("says the server's own refusal out loud", async () => {
    vi.spyOn(api, "queue").mockResolvedValue(withWork());
    vi.spyOn(api, "approve").mockRejectedValue(
      new ApiError(409, "This draft changed since you opened it."),
    );

    renderQueue();
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This draft changed since you opened it.");
    // ...and the control is usable again, rather than stuck disabled.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled(),
    );
  });

  it("announces the outcome somewhere that OUTLIVES the row", async () => {
    // The bug this replaces: the live region was inside the row. The approval
    // succeeded, the queue refetched, the row unmounted, and the sentence went
    // with it — a screen-reader user heard nothing at all while the thing they
    // were on disappeared. jsdom could not catch it, because the test held the
    // request pending and the row never unmounted. A real browser did.
    //
    // So this asserts the announcement lands in the SHARED region, and it does
    // so without rendering the queue's row at all.
    vi.spyOn(api, "queue").mockResolvedValue(withWork());
    vi.spyOn(api, "approve").mockResolvedValue(null);

    // The shell's region and the route, mounted separately — which is exactly
    // how they sit in the real application.
    const shell = render(<Announcer />);
    const route = renderQueue();

    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(shell.container.textContent).toMatch(/approved/i),
    );

    // The route's whole tree can go, and the sentence is still there to read.
    route.unmount();
    expect(shell.container.textContent).toMatch(/approved/i);
  });

  it("will not send a page back without a reason", async () => {
    // A send-back with no note is a round trip nobody can act on.
    vi.spyOn(api, "queue").mockResolvedValue(withWork());
    const sendBack = vi.spyOn(api, "sendBack").mockResolvedValue(null);

    renderQueue();
    await userEvent.click(await screen.findByRole("button", { name: "Send back" }));

    // Scoped to the dialog: its submit carries the same label as the control
    // that opened it, which is right for the reader and ambiguous for a query.
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Send back" }));

    expect(sendBack).not.toHaveBeenCalled();
    // The note field is what stopped it, and it says so.
    expect(within(dialog).getByLabelText(/what needs to change/i)).toBeRequired();
  });

  it("names a backdated page with no stated basis, which is what an auditor asks about", async () => {
    vi.spyOn(api, "queue").mockResolvedValue(
      queue({
        awaitingMyApproval: [page({ backdated: true, backdatedWithoutBasis: true })],
        counts: { ...queue().counts, awaitingMyApproval: 1, total: 1 },
      }),
    );
    renderQueue();
    expect(await screen.findByText("Backdated, no stated basis")).toBeInTheDocument();
  });

  it("links a queued page by its pageId, not an id it does not have", async () => {
    // The queue's strands name it `pageId`; reading `id` here would point every
    // link at /pages/undefined.
    vi.spyOn(api, "queue").mockResolvedValue(withWork());
    renderQueue();
    expect(await screen.findByRole("link", { name: "Parental leave" })).toHaveAttribute(
      "href",
      "#/pages/p1",
    );
  });
});
