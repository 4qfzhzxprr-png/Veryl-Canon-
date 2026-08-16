import { NavLink } from "react-router-dom";

/**
 * Primary navigation within thumb reach, phones only — desktop keeps the top
 * nav, because two primary navigations on one screen is a question the reader
 * answers before every click.
 *
 * The destination list is data rather than markup so the "which tab is active"
 * rule stays one expression instead of one per tab, and so adding a
 * destination is an entry rather than a copied block.
 */
const TABS = [
  { to: "/", label: "Collections", icon: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" },
  { to: "/queue", label: "My queue", icon: "M4 4h16v10a2 2 0 0 1-2 2h-3l-3 3-3-3H6a2 2 0 0 1-2-2z" },
  { to: "/audit", label: "Audit", icon: "M5 4h14v16H5zM9 9h6M9 13h6M9 17h3" },
] as const;

export function TabBar() {
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden"
    >
      <ul className="flex items-stretch">
        {TABS.map((tab) => (
          <li key={tab.to} className="flex-1">
            <NavLink
              to={tab.to}
              end={tab.to === "/"}
              className={({ isActive }) =>
                // 56px so the tap target clears the 44px floor with room for a
                // label underneath.
                `flex min-h-[56px] flex-col items-center justify-center gap-[3px] px-0.5 py-1.5 text-[11px] font-medium ${
                  isActive ? "text-action" : "text-muted"
                }`
              }
              aria-label={tab.label}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d={tab.icon} />
              </svg>
              <span>{tab.label}</span>
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
