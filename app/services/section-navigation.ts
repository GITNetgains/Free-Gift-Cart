import type { ShouldRevalidateFunctionArgs } from "react-router";

// Switching a presentation tab must not reload saved values over an unsaved form.
// Submissions, explicit refreshes, filters and switching features still revalidate.
export function shouldRevalidateSections({ currentUrl, nextUrl, formMethod, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (formMethod || currentUrl.pathname !== nextUrl.pathname) return defaultShouldRevalidate;
  const current = new URL(currentUrl);
  const next = new URL(nextUrl);
  const changed = ["part", "section"].some((key) => current.searchParams.get(key) !== next.searchParams.get(key));
  for (const key of ["part", "section"]) {
    current.searchParams.delete(key);
    next.searchParams.delete(key);
  }
  current.searchParams.sort();
  next.searchParams.sort();
  return changed && current.search === next.search ? false : defaultShouldRevalidate;
}
