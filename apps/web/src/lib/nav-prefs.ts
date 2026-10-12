/** Cookie holding whether the app's left rail shows labels ("1") or icons only (anything else). */
export const NAV_EXPANDED_COOKIE = "ai-news-nav-expanded";

/** The rail state for a request, from its cookie store (layouts pass `await cookies()`). */
export function navExpanded(store: { get: (name: string) => { value: string } | undefined }) {
  return store.get(NAV_EXPANDED_COOKIE)?.value === "1";
}
