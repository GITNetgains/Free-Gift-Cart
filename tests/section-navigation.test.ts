import { describe, expect, it } from "vitest";
import type { ShouldRevalidateFunctionArgs } from "react-router";
import { shouldRevalidateSections } from "../app/services/section-navigation";

const check = (from: string, to: string, formMethod?: "POST") => shouldRevalidateSections({
  currentUrl: new URL(from, "https://app.example"), nextUrl: new URL(to, "https://app.example"),
  currentParams: {}, nextParams: {}, defaultShouldRevalidate: true, formMethod,
} as ShouldRevalidateFunctionArgs);

describe("Management section navigation", () => {
  it("preserves unsaved gift and settings values when changing tabs", () => {
    expect(check("/app/free-gift", "/app/free-gift?section=products")).toBe(false);
    expect(check("/app/help-desk?settings=1", "/app/help-desk?settings=1&part=team")).toBe(false);
  });
  it("loads data when switching between settings and chatbot", () => {
    expect(check("/app/help-desk?settings=1&part=team", "/app/help-desk?chatbot=1&part=widget")).toBe(true);
  });
  it("refreshes after saves and explicit refreshes", () => {
    expect(check("/app/free-gift", "/app/free-gift?section=products", "POST")).toBe(true);
    expect(check("/app/free-gift?section=products", "/app/free-gift?section=products")).toBe(true);
  });
  it("loads changed ticket filters and other routes", () => {
    expect(check("/app/help-desk?section=setup", "/app/help-desk?view=chats")).toBe(true);
    expect(check("/app/free-gift", "/app/help-desk?section=setup")).toBe(true);
  });
});
