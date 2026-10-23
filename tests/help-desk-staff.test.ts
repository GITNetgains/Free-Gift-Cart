import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { assignableTeam, recordStaff, staffName } from "../app/services/help-desk-staff.server";

const fakeDb = (existing: unknown = null) => {
  const helpDeskStaff = { findUnique: vi.fn().mockResolvedValue(existing), create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) };
  return { db: { helpDeskStaff } as unknown as PrismaClient, helpDeskStaff };
};

describe("Help Desk staff", () => {
  it("names staff from their Shopify profile, falling back to their email", () => {
    expect(staffName({ first_name: "Priya", last_name: " Sharma " })).toBe("Priya Sharma");
    expect(staffName({ email: "rahul@zioncases.com" })).toBe("rahul");
  });
  it("records a staff member the first time they open the Help Desk", async () => {
    const { db, helpDeskStaff } = fakeDb();
    expect(await recordStaff(db, "shop.myshopify.com", { id: 42, first_name: "Priya", last_name: "Sharma", email: "p@z.com", account_owner: true })).toBe("Priya Sharma");
    expect(helpDeskStaff.create).toHaveBeenCalledWith({ data: { shop: "shop.myshopify.com", userId: "42", name: "Priya Sharma", email: "p@z.com", accountOwner: true } });
  });
  it("doesn't rewrite an unchanged, recently seen staff member", async () => {
    const { db, helpDeskStaff } = fakeDb({ id: "s1", name: "Priya Sharma", email: "p@z.com", lastSeenAt: new Date() });
    await recordStaff(db, "shop.myshopify.com", { id: 42, first_name: "Priya", last_name: "Sharma", email: "p@z.com" });
    expect(helpDeskStaff.update).not.toHaveBeenCalled();
  });
  it("skips requests without a signed-in staff member", async () => {
    const { db, helpDeskStaff } = fakeDb();
    expect(await recordStaff(db, "shop.myshopify.com", undefined)).toBe("");
    expect(helpDeskStaff.findUnique).not.toHaveBeenCalled();
  });
  it("offers visible staff first, then typed names, without duplicates", () => {
    expect(assignableTeam([{ name: "Priya Sharma", hidden: false }, { name: "Old Account", hidden: true }], ["Warehouse", "Priya Sharma"])).toEqual(["Priya Sharma", "Warehouse"]);
  });
});
