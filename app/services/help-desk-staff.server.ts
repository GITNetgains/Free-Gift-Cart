import type { PrismaClient } from "@prisma/client";

// Shopify staff who can be assigned Help Desk tickets. The Staff API needs
// Shopify Plus, so instead each staff member is recorded the first time they
// open the Help Desk, from the online session Shopify gives the app for them.

type OnlineUser = { id: number | string; first_name?: string; last_name?: string; email?: string; account_owner?: boolean } | undefined;

export const staffName = (user: { first_name?: string; last_name?: string; email?: string }) =>
  [user.first_name, user.last_name].map((part) => part?.trim()).filter(Boolean).join(" ") || user.email?.split("@")[0] || "Staff member";

// Records (or refreshes) the staff member using the app and returns their name.
// Seen-time updates are throttled to once an hour per person.
export async function recordStaff(db: PrismaClient, shop: string, user: OnlineUser) {
  if (!user?.id) return "";
  const userId = String(user.id);
  const name = staffName(user).slice(0, 60);
  try {
    const existing = await db.helpDeskStaff.findUnique({ where: { shop_userId: { shop, userId } } });
    if (!existing) {
      await db.helpDeskStaff.create({ data: { shop, userId, name, email: user.email || "", accountOwner: Boolean(user.account_owner) } });
    } else if (existing.name !== name || existing.email !== (user.email || "") || Date.now() - existing.lastSeenAt.getTime() > 3600_000) {
      await db.helpDeskStaff.update({ where: { id: existing.id }, data: { name, email: user.email || "", accountOwner: Boolean(user.account_owner), lastSeenAt: new Date() } });
    }
  } catch (error) {
    console.error(`Help Desk could not record staff member for ${shop}:`, error);
  }
  return name;
}

export async function listStaff(db: PrismaClient, shop: string) {
  return db.helpDeskStaff.findMany({ where: { shop }, orderBy: [{ accountOwner: "desc" }, { name: "asc" }], select: { id: true, name: true, email: true, accountOwner: true, hidden: true, lastSeenAt: true } });
}

// Everyone tickets can be assigned to: visible staff, then names typed in settings.
export function assignableTeam(staff: { name: string; hidden: boolean }[], typed: string[]) {
  return [...new Set([...staff.filter((member) => !member.hidden).map((member) => member.name), ...typed])];
}
