import type { PrismaClient } from "@prisma/client";
import {
  emailConfigured, notifyCustomerReply, notifyTicket, sendAcknowledgement, sendReplyEmail, sendStatusEmail, type SendResult,
} from "./help-desk-email.server";

// Every Help Desk email goes through this queue: a row is saved first, then
// sent straight away, and a failed send is retried after 1 and 5 minutes
// before it's marked failed. Agents see each email's state on the ticket and
// can retry a failed one.

export type EmailKind = "new-ticket" | "ack" | "reply" | "customer-reply" | "status";
type AdminClient = Parameters<typeof notifyTicket>[2];

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [60_000, 5 * 60_000];
const POLL_MS = 60_000;
// A row left "processing" this long belongs to a send that died mid-way.
const STUCK_MS = 10 * 60_000;

async function deliver(db: PrismaClient, admin: AdminClient, row: { shop: string; ticketId: string; messageId: string | null; kind: string }): Promise<SendResult> {
  switch (row.kind) {
    case "new-ticket": return notifyTicket(db, row.shop, admin, row.ticketId);
    case "ack": return sendAcknowledgement(db, row.shop, admin, row.ticketId);
    case "status": return sendStatusEmail(db, row.shop, admin, row.ticketId);
    case "reply": return row.messageId ? sendReplyEmail(db, row.shop, admin, row.messageId) : "skipped";
    case "customer-reply": return row.messageId ? notifyCustomerReply(db, row.shop, admin, row.messageId) : "skipped";
    default: return "skipped";
  }
}

// Sends one queued email. Never throws: the outcome is recorded on the row.
export async function processEmail(db: PrismaClient, id: string, admin?: AdminClient) {
  // Claim the row so the immediate send and the poller never both send it.
  const { count } = await db.helpDeskEmail.updateMany({ where: { id, status: "pending" }, data: { status: "processing" } });
  if (!count) return;
  const row = await db.helpDeskEmail.findUniqueOrThrow({ where: { id } });
  const attempts = row.attempts + 1;
  try {
    if (!emailConfigured()) {
      await db.helpDeskEmail.update({ where: { id }, data: { status: "skipped", attempts, lastError: "Email sending isn't set up on the server." } });
      return;
    }
    // Background retries have no request, so they use the shop's stored offline session.
    const client = admin ?? (await (await import("../shopify.server")).unauthenticated.admin(row.shop)).admin;
    const result = await deliver(db, client, row);
    await db.helpDeskEmail.update({ where: { id }, data: { status: result, attempts, lastError: "", sentAt: result === "sent" ? new Date() : null } });
  } catch (error) {
    const failed = attempts >= MAX_ATTEMPTS;
    console.error(`Help Desk ${row.kind} email ${id} on ${row.shop} failed (attempt ${attempts}):`, error);
    await db.helpDeskEmail.update({
      where: { id },
      data: {
        status: failed ? "failed" : "pending", attempts, lastError: String((error as Error)?.message || error).slice(0, 500),
        nextAttemptAt: new Date(Date.now() + (BACKOFF_MS[attempts - 1] ?? 15 * 60_000)),
      },
    }).catch(() => undefined);
  }
}

// Queues an email and tries it right away in the background. Never throws,
// so a mail problem can't fail the request that triggered it.
export function queueEmail(db: PrismaClient, input: { shop: string; ticketId: string; kind: EmailKind; messageId?: string }, admin?: AdminClient) {
  ensureWorker(db);
  void (async () => {
    try {
      const row = await db.helpDeskEmail.create({ data: { ...input, messageId: input.messageId ?? null } });
      await processEmail(db, row.id, admin);
    } catch (error) {
      console.error(`Help Desk could not queue a ${input.kind} email for ticket ${input.ticketId}:`, error);
    }
  })();
}

// Sends the queued emails that are due, including retries.
export async function processDueEmails(db: PrismaClient) {
  await db.helpDeskEmail.updateMany({ where: { status: "processing", nextAttemptAt: { lt: new Date(Date.now() - STUCK_MS) } }, data: { status: "pending" } });
  const due = await db.helpDeskEmail.findMany({ where: { status: "pending", nextAttemptAt: { lte: new Date() } }, orderBy: { nextAttemptAt: "asc" }, take: 25, select: { id: true } });
  for (const { id } of due) await processEmail(db, id);
}

// Puts a failed or skipped email back in the queue and sends it now.
export async function retryEmail(db: PrismaClient, shop: string, id: string, admin?: AdminClient) {
  const { count } = await db.helpDeskEmail.updateMany({
    where: { id, shop, status: { in: ["failed", "skipped"] } },
    data: { status: "pending", attempts: 0, lastError: "", nextAttemptAt: new Date() },
  });
  if (count) await processEmail(db, id, admin);
  return count === 1;
}

const worker = globalThis as typeof globalThis & { helpDeskEmailWorker?: ReturnType<typeof setInterval> };

// Retries run from a timer in this server process, started with the first email.
export function ensureWorker(db: PrismaClient) {
  if (worker.helpDeskEmailWorker || process.env.VITEST) return;
  worker.helpDeskEmailWorker = setInterval(() => {
    processDueEmails(db).catch((error) => console.error("Help Desk email queue failed:", error));
  }, POLL_MS);
  worker.helpDeskEmailWorker.unref?.();
}
