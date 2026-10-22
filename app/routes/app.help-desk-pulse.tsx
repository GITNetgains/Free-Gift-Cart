import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";

// A cheap fingerprint of what the open Help Desk screen shows. The admin polls
// it every few seconds and reloads the full page (orders and all) only when it
// changes, so customer messages and photo checks appear like in a chat app.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { shop } = session;
  const ticketId = new URL(request.url).searchParams.get("ticket");
  const headers = { "Cache-Control": "private, no-store" };

  if (ticketId) {
    const [ticket, messages, scans] = await Promise.all([
      db.helpDeskTicket.findFirst({ where: { id: ticketId, shop }, select: { updatedAt: true } }),
      db.helpDeskMessage.aggregate({ where: { ticketId, ticket: { shop } }, _count: true, _max: { createdAt: true } }),
      db.helpDeskImageScan.aggregate({ where: { shop, attachment: { ticketId } }, _count: true, _max: { updatedAt: true } }),
    ]);
    if (!ticket) return Response.json({ stamp: "gone" }, { headers });
    const stamp = [ticket.updatedAt.getTime(), messages._count, messages._max.createdAt?.getTime() ?? 0, scans._count, scans._max.updatedAt?.getTime() ?? 0].join(".");
    return Response.json({ stamp }, { headers });
  }

  const tickets = await db.helpDeskTicket.aggregate({ where: { shop }, _count: true, _max: { updatedAt: true } });
  return Response.json({ stamp: `${tickets._count}.${tickets._max.updatedAt?.getTime() ?? 0}` }, { headers });
};
