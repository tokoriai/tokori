/**
 * Global "navigate to a tab" event.
 *
 * Most navigation goes through onNavigate props (Sidebar → Shell), but
 * a few deeply-nested components — the click-to-define popover, the
 * vocab-empty CTA buttons, etc. — need to switch tabs without a
 * prop-drilling pipeline that would touch every chat-message render.
 *
 * Usage:
 *   // Trigger
 *   navigateToTab("settings");
 *
 *   // Listen (in Shell — sets the active tab)
 *   useEffect(() => {
 *     return onNavigateToTab((tab) => setTab(tab));
 *   }, []);
 *
 * Pair with `requestSettingsIntent` for deep-links into a specific
 * settings section + auto-action.
 */

export const NAV_EVENT = "tokori:navigate";

type NavDetail = { tab: string };

export function navigateToTab(tab: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<NavDetail>(NAV_EVENT, { detail: { tab } }));
}

export function onNavigateToTab(handler: (tab: string) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<NavDetail>).detail;
    if (detail?.tab) handler(detail.tab);
  };
  window.addEventListener(NAV_EVENT, listener);
  return () => window.removeEventListener(NAV_EVENT, listener);
}
