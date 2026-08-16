import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Announcer } from "./Announcer";
import { BrandMark } from "./BrandMark";
import { TabBar } from "./TabBar";
import type { Actor } from "@/types/api";

/**
 * The chrome, matched to the Registry's to the pixel: 56px bar, 28px mark, a
 * 17px wordmark at 700 tracked tight, translucent over a blur, padded for the
 * notch.
 *
 * A skip link first, because a keyboard user should not tab the whole nav to
 * reach the page — and it is the first focusable element or it is nothing.
 */
export function AppShell({ actor, children }: { actor: Actor | null; children: ReactNode }) {
  return (
    <div className="min-h-full">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-md focus:bg-surface focus:px-md focus:py-2 focus:text-ui focus:font-medium focus:shadow-card focus:ring-2 focus:ring-action"
      >
        Skip to the page
      </a>

      <header className="sticky top-0 z-40 border-b border-border bg-surface/95 pt-[env(safe-area-inset-top)] backdrop-blur">
        <div className="flex h-14 items-center gap-3 px-md sm:px-lg">
          <Link to="/" className="flex items-center gap-2.5" aria-label="Veryl Canon — home">
            <BrandMark />
            <span className="text-[17px] font-bold tracking-tight">Veryl Canon</span>
          </Link>
          {actor ? (
            <span className="ml-auto truncate text-meta text-muted">{actor.name}</span>
          ) : null}
        </div>
      </header>

      {/* tabIndex so the skip link has somewhere to land. Not in the tab order:
          only script and that link reach it. */}
      <main id="main" tabIndex={-1} className="pb-[calc(72px+env(safe-area-inset-bottom))] sm:pb-0">
        {children}
      </main>

      <TabBar />

      {/* Outside every route, and always present: an outcome has to outlive
          whatever caused it, and a region added at the same moment as its text
          is not announced at all. */}
      <Announcer />
    </div>
  );
}
